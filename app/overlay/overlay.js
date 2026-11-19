// Zulip overlay script. The desktop app injects this into the stock Zulip
// web page of the configured organization (see app/common/overlay-config.ts).
//
// It redraws the page; it never changes Zulip's own code or data model.
//   F1 votes            arrows + score on each topic header (the main thing),
//                       and on messages on hover; a sort control on each
//                       channel's topic list (hot, most or least upvoted).
//                       Data: our service.
//   F2 replies          a Reply button that starts an ordinary message with a
//                       one-line link header, drawn as a reference line
//                       above the reply. Order stays linear; no indenting.
//                       Data: Zulip (the message text).
//   F3 threads          a Thread button on a message starts a topic named
//                       "Parent / Child" that links back to that message;
//                       the message shows its threads, and the left sidebar
//                       folds them under "Parent". Data: Zulip (topic name
//                       and the first message's link).
//   F4 reactions        a one-click reaction bar on hover. Data: Zulip.
//   F5 inline reactions select a passage, pick an emoji. Data: our service.
//   F6 rendering        time-gap dividers, tinted AI spoiler blocks. No data.
//
// Page structure it depends on (zulip web/templates on zulip-cloud-current):
//   .message_row[data-message-id]            a message; .private-message = DM
//   .messagebox > .messagebox-content        its box; a click on .messagebox
//                                            opens Zulip's reply compose box
//   .message_content                         the rendered message
//   .recipient_row                           a run of messages in one topic
//   .message_header_stream[data-stream-id][data-topic-name]
//     > .message-header-contents             the topic header bar
//   li.topic-list-item[data-topic-name]      a topic in the left sidebar
//   .message_reaction.reacted[data-reaction-id]
//   #compose-textarea, #stream_message_recipient_topic, #new_conversation_button
//   input[name=csrfmiddlewaretoken]          Zulip's own request token
// Every element this script adds carries the attribute data-zo.
// If the first message row we see lacks a message box or text, the overlay
// turns itself off and says so once, leaving the page stock. Beyond that each
// feature checks the elements only it needs and turns just itself off.
// A button in the top bar opens the overlay's settings: per-feature switches,
// the time-gap threshold and the six one-click emoji (localStorage).
// Without the overlay service only votes and inline reactions are hidden; the
// service is retried every ten seconds.
// Signing in to the service: the script asks it for a one-time code, sends
// the code as a Zulip direct message to the overlay's bot with the page's own
// session, and gets a token back once the bot has seen who sent it. The token
// is kept in localStorage. No Zulip credential goes to the service.
// Votes and inline reactions are offered only in public channels (and any
// private channel the service names); elsewhere their controls are not drawn
// and the service is not told which messages are on screen.

(() => {
  if (globalThis.__zulipOverlay) {
    return;
  }

  const bridge = globalThis.zulip_overlay;
  if (bridge === undefined) {
    return;
  }

  const GAP_MINUTES = 30; // Default threshold; a per-user setting.
  const MAX_TOPIC_LENGTH = 60; // Zulip's limit, in code points.
  const SEPARATOR = " / "; // Sub-topic separator.
  const RESOLVED_PREFIX = "✔ ";
  // Emoji a user can put in their one-click reaction bar:
  // [Zulip emoji name, Zulip emoji code, glyph]. Each user picks six.
  const palette = [
    ["+1", "1f44d", "\u{1F44D}"],
    ["-1", "1f44e", "\u{1F44E}"],
    ["heart", "2764", "❤️"],
    ["joy", "1f602", "\u{1F602}"],
    ["tada", "1f389", "\u{1F389}"],
    ["thinking", "1f914", "\u{1F914}"],
    ["eyes", "1f440", "\u{1F440}"],
    ["100", "1f4af", "\u{1F4AF}"],
    ["fire", "1f525", "\u{1F525}"],
    ["pray", "1f64f", "\u{1F64F}"],
    ["rocket", "1f680", "\u{1F680}"],
    ["clap", "1f44f", "\u{1F44F}"],
    ["raised_hands", "1f64c", "\u{1F64C}"],
    ["wave", "1f44b", "\u{1F44B}"],
    ["check", "2705", "✅"],
    ["cross_mark", "274c", "❌"],
    ["cry", "1f622", "\u{1F622}"],
    ["open_mouth", "1f62e", "\u{1F62E}"],
  ];
  const QUICK_COUNT = 6;
  const defaultQuick = ["+1", "heart", "joy", "tada", "thinking", "eyes"];
  const glyphOf = new Map(palette.map(([name, , glyph]) => [name, glyph]));

  // Features a user can switch off, in the order the settings panel lists
  // them. Stored on this machine only.
  const features = [
    ["votes", "Votes and vote sorting"],
    ["replies", "Replies"],
    ["threads", "Threads and nested topics"],
    ["reactions", "One-click reactions"],
    ["inline", "Inline reactions"],
    ["gaps", "Time-gap dividers"],
    ["ai", "Tinted AI blocks"],
  ];

  const state = {
    token: undefined,
    userId: undefined,
    scores: {message: new Map(), topic: new Map()}, // Id -> {score, my_vote}
    meta: new Map(), // Message id -> {stream_id, topic, sender_id, sender_name, timestamp}
    metaUnavailable: false, // Zulip refused the message-details request
    anchors: new Map(), // Topic key -> Promise of its first message, or undefined
    users: new Map(), // User id -> Promise of {is_bot, full_name}
    inline: new Map(), // Message id -> [{start, end, hash, emoji, user_ids, mine}]
    parents: new Map(), // Reply message id -> parent message id (same topic)
    threads: new Map(), // Message id -> [{streamId, topic, label}] started from it
    sortChecks: new Map(), // Channel id -> time its sort data was last loaded
    topicInfo: new Map(), // Topic key -> {anchorId, last} (last message time)
    threadChecks: new Map(), // Root topic key -> time threads were last looked up
    pending: new Set(),
    flushTimer: undefined,
    nestTimer: undefined,
    structureChecked: false,
    disabled: false,
    settings: undefined, // Parsed copy of localStorage "zo-settings"
    broken: new Set(), // Features turned off because the page changed
    messages: new Map(), // Message id -> Promise of {streamId, topic, text}
    signingIn: undefined, // The sign-in in flight, so only one runs at a time
    signInFailed: false, // The service refused us; do not keep asking
    extraStreams: new Set(), // Private channels the service accepts
    covered: new Map(), // Channel id -> true/false, or a Promise of it
    uncovered: new Set(), // Message ids on the page the service must not see
  };
  const VERSION = "0.3.2-alpha";
  globalThis.__zulipOverlay = {version: VERSION, state};

  function element(tag, className, text) {
    const $element = document.createElement(tag);
    $element.dataset.zo = "";
    if (className !== undefined) {
      $element.className = className;
    }

    if (text !== undefined) {
      $element.textContent = text;
    }

    return $element;
  }

  // --------------------------------------------------------------- settings

  function settings() {
    if (state.settings === undefined) {
      const stored = JSON.parse(localStorage.getItem("zo-settings") ?? "{}");
      const emoji = (stored.emoji ?? defaultQuick).filter((name) =>
        glyphOf.has(name),
      );
      state.settings = {
        off: stored.off ?? [],
        gapMinutes: stored.gapMinutes ?? GAP_MINUTES,
        emoji: emoji.length === QUICK_COUNT ? emoji : defaultQuick,
      };
    }

    return state.settings;
  }

  function isOn(feature) {
    return !settings().off.includes(feature) && !state.broken.has(feature);
  }

  function quickEmoji() {
    return settings().emoji.map((name) =>
      palette.find(([candidate]) => candidate === name),
    );
  }

  // Features are switched off by hiding what they draw (see overlay.css), so
  // a change takes effect at once and nothing has to be rebuilt.
  function applySettings() {
    for (const [feature] of features) {
      document.body.classList.toggle(`zo-off-${feature}`, !isOn(feature));
    }

    for (const $quick of document.querySelectorAll(".zo-quick")) {
      fillQuick($quick);
    }

    for (const $group of document.querySelectorAll(".recipient_row")) {
      markGaps($group);
    }

    nestAll();
  }

  function saveSettings(change) {
    state.settings = {...settings(), ...change};
    localStorage.setItem("zo-settings", JSON.stringify(state.settings));
    applySettings();
  }

  // A feature whose page elements are missing turns itself off for this
  // session; the rest of the overlay keeps working.
  function breakFeature(feature, why) {
    if (state.broken.has(feature)) {
      return;
    }

    state.broken.add(feature);
    const names = features
      .filter(([name]) => state.broken.has(name))
      .map(([, label]) => label.toLowerCase());
    notice(
      `Zulip's page layout has changed (${why}); turned off until the app is updated: ${names.join(", ")}`,
    );
    applySettings();
  }

  function closeSettingsPanel() {
    document.querySelector(".zo-settings")?.remove();
  }

  function openSettingsPanel($anchor) {
    if (document.querySelector(".zo-settings") !== null) {
      closeSettingsPanel();
      return;
    }

    const $panel = element("div", "zo-settings");
    $panel.append(element("div", "zo-settings-title", "Overlay settings"));
    for (const [feature, label] of features) {
      const $label = element("label", "zo-settings-row");
      const $box = element("input");
      $box.type = "checkbox";
      $box.checked = !settings().off.includes(feature);
      $box.disabled = state.broken.has(feature);
      $box.addEventListener("change", () => {
        const off = settings().off.filter((name) => name !== feature);
        saveSettings({off: $box.checked ? off : [...off, feature]});
      });
      $label.append(
        $box,
        element(
          "span",
          undefined,
          state.broken.has(feature) ? `${label} (off: page changed)` : label,
        ),
      );
      $panel.append($label);
    }

    const $gap = element("label", "zo-settings-row");
    const $minutes = element("input");
    $minutes.type = "number";
    $minutes.min = "1";
    $minutes.max = "1440";
    $minutes.value = String(settings().gapMinutes);
    $minutes.addEventListener("change", () => {
      const minutes = Math.round(Number($minutes.value));
      if (minutes >= 1 && minutes <= 1440) {
        saveSettings({gapMinutes: minutes});
      } else {
        $minutes.value = String(settings().gapMinutes);
      }
    });
    $gap.append(
      element("span", undefined, "Divider after a gap of"),
      $minutes,
      element("span", undefined, "minutes"),
    );
    $panel.append($gap);

    $panel.append(
      element(
        "div",
        "zo-settings-heading",
        `One-click reactions (pick ${QUICK_COUNT})`,
      ),
    );
    const $palette = element("div", "zo-settings-palette");
    const $hint = element("div", "zo-settings-hint");
    const draw = () => {
      $palette.textContent = "";
      const chosen = [...$palette.dataset.chosen.split(",")].filter(
        (name) => name !== "",
      );
      for (const [name, , glyph] of palette) {
        const $pick = element("button", "zo-settings-emoji", glyph);
        $pick.type = "button";
        $pick.title = `:${name}:`;
        $pick.classList.toggle("zo-mine", chosen.includes(name));
        $pick.addEventListener("click", () => {
          const next = chosen.includes(name)
            ? chosen.filter((other) => other !== name)
            : [...chosen, name];
          if (next.length > QUICK_COUNT) {
            return;
          }

          $palette.dataset.chosen = next.join(",");
          if (next.length === QUICK_COUNT) {
            // Keep the palette's order in the bar.
            saveSettings({
              emoji: palette
                .map(([candidate]) => candidate)
                .filter((candidate) => next.includes(candidate)),
            });
          }

          draw();
        });
        $palette.append($pick);
      }

      $hint.textContent =
        chosen.length === QUICK_COUNT
          ? "Click one to swap it out."
          : `Pick ${QUICK_COUNT - chosen.length} more; the bar keeps its old set until then.`;
    };

    $palette.dataset.chosen = settings().emoji.join(",");
    draw();
    $panel.append($palette, $hint);
    $panel.append(
      element(
        "div",
        "zo-settings-hint",
        "Stored on this computer. Votes are anonymous in the app; the overlay service records who voted so nobody votes twice.",
      ),
    );

    for (const type of ["click", "mousedown", "keydown", "keyup", "keypress"]) {
      $panel.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    }

    const box = $anchor.getBoundingClientRect();
    $panel.style.top = `${box.bottom + 6}px`;
    $panel.style.right = `${Math.max(8, innerWidth - box.right)}px`;
    document.body.append($panel);
  }

  // A button in Zulip's top bar, left of the help menu.
  function addSettingsButton() {
    if (document.querySelector(".zo-settings-button") !== null) {
      return;
    }

    const $help = document.querySelector("#help-menu, #gear-menu");
    if ($help === null) {
      return;
    }

    const $item = element("div", "navbar-item zo-settings-button");
    const $button = element("a", "header-button", "\u25E7");
    $button.setAttribute("role", "button");
    $button.tabIndex = 0;
    $button.title = "Overlay settings";
    $button.setAttribute("aria-label", "Overlay settings");
    $button.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openSettingsPanel($button);
    });
    $item.append($button);
    $help.before($item);
  }

  // ---------------------------------------------------------------- notices

  function notice(text) {
    document.querySelector(".zo-notice")?.remove();
    const $notice = element(
      "div",
      "zo-notice",
      `Overlay: ${text} (click to dismiss)`,
    );
    $notice.addEventListener("click", () => {
      $notice.remove();
    });
    document.body.append($notice);
  }

  function setServiceUp(up) {
    const wasDown = document.body.classList.contains("zo-service-down");
    document.body.classList.toggle("zo-service-down", !up);
    if (up && wasDown) {
      for (const $votes of document.querySelectorAll(".zo-votes")) {
        queue($votes.dataset.kind, Number($votes.dataset.zoId));
      }
    }

    if (up) {
      clearInterval(state.retryTimer);
      state.retryTimer = undefined;
      return;
    }

    // Refused rather than unreachable: the reason is already on screen and
    // asking again would not change it.
    if (state.signInFailed) {
      return;
    }

    notice(
      "the overlay service cannot be reached; votes and inline reactions are hidden until it is back",
    );
    // Keep looking for the service, so its controls come back by themselves.
    state.retryTimer ??= setInterval(async () => {
      if (state.signInFailed) {
        return;
      }

      const back =
        state.token === undefined
          ? await signIn()
          : (await bridge.request("GET", "/health")).status === 200;
      if (back) {
        setServiceUp(true);
        document.querySelector(".zo-notice")?.remove();
      }
    }, 10_000);
  }

  // ------------------------------------------------------ service and Zulip

  // True once the service knows who we are. One sign-in runs at a time.
  function signIn() {
    state.signingIn ??= exchange().finally(() => {
      state.signingIn = undefined;
    });
    return state.signingIn;
  }

  function compareVersions(a, b) {
    const parts = (version) =>
      version.split("-")[0].split(".").map(Number);
    const [left, right] = [parts(a), parts(b)];
    for (let index = 0; index < 3; index += 1) {
      if ((left[index] ?? 0) !== (right[index] ?? 0)) {
        return (left[index] ?? 0) - (right[index] ?? 0);
      }
    }

    return 0;
  }

  async function exchange() {
    const health = await bridge.request("GET", "/health");
    if (health.status !== 200) {
      return false;
    }

    state.extraStreams = new Set(health.body.extra_streams ?? []);
    const latest = health.body.latest_version;
    if (
      typeof latest === "string" &&
      compareVersions(VERSION, latest) < 0 &&
      !state.updateNoticed
    ) {
      state.updateNoticed = true;
      const where = health.body.download_url;
      notice(
        `a newer version of this app (${latest}) is available${typeof where === "string" ? ` at ${where}` : ""}`,
      );
    }

    // A service run for development on this machine trusts the id we send.
    if (health.body.dev_auth === true) {
      const response = await bridge.request("POST", "/dev/login", {
        user_id: state.userId,
      });
      state.token = response.status === 200 ? response.body.token : undefined;
      return response.status === 200;
    }

    // A token from an earlier run, if the service still accepts it for this
    // Zulip account.
    const tokenKey = `zo-token-${state.userId}`;
    const stored = localStorage.getItem(tokenKey);
    if (stored !== null) {
      const me = await bridge.request("GET", "/auth/me", undefined, stored);
      if (me.status === 200 && me.body.user_id === state.userId) {
        state.token = stored;
        return true;
      }

      if (me.status === 0) {
        return false;
      }

      localStorage.removeItem(tokenKey);
      if (me.status === 403) {
        return refused(me);
      }
    }

    const started = await bridge.request("POST", "/auth/start");
    if (started.status !== 200) {
      return started.status === 0 ? false : refused(started);
    }

    const sent = await zulipWrite("POST", "/messages", {
      type: "direct",
      to: JSON.stringify([started.body.bot_user_id]),
      content: started.body.code,
    });
    if (sent === false) {
      state.signInFailed = true;
      return false;
    }

    // The message has done its job once the service has answered, whatever
    // the answer: take it out of the user's direct messages again. If the
    // organization does not let people delete their messages it stays.
    const tidy = () => {
      void zulipWrite("DELETE", `/messages/${sent.id}`, {}, true);
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const finished = await bridge.request("POST", "/auth/finish", {
        code: started.body.code,
      });
      if (finished.status === 200 && finished.body.user_id === state.userId) {
        tidy();
        state.token = finished.body.token;
        localStorage.setItem(tokenKey, state.token);
        return true;
      }

      if (finished.status !== 404) {
        tidy();
        return finished.status === 0 ? false : refused(finished);
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1500);
      });
    }

    tidy();
    state.signInFailed = true;
    notice(
      "could not sign in to the overlay service (its bot did not receive the code); votes and inline reactions are off until the app is restarted",
    );
    return false;
  }

  // The service answered and said no. Say why once and stop asking, so a
  // refusal does not turn into a direct message to the bot every ten seconds.
  function refused(response) {
    state.signInFailed = true;
    state.token = undefined;
    const detail = response.body?.detail;
    notice(
      `${typeof detail === "string" ? detail : `the overlay service refused sign-in (${response.status})`}; votes and inline reactions are off`,
    );
    return false;
  }

  // Whether the service takes votes and inline reactions for this channel:
  // public channels, plus any private ones it names.
  function covers(streamId) {
    if (streamId === undefined || Number.isNaN(streamId)) {
      return Promise.resolve(false);
    }

    if (!state.covered.has(streamId)) {
      state.covered.set(
        streamId,
        zulipGet(`/streams/${streamId}`).then((result) => {
          const covered =
            state.extraStreams.has(streamId) ||
            result?.stream?.invite_only === false;
          state.covered.set(streamId, covered);
          return covered;
        }),
      );
    }

    return Promise.resolve(state.covered.get(streamId));
  }

  // Returns the parsed body, or undefined when the service is unreachable or
  // answers with an error. Both cases are reported to the user.
  async function service(method, path, body) {
    if (state.token === undefined) {
      return undefined;
    }

    let response = await bridge.request(method, path, body, state.token);
    if (response.status === 401 && !state.signInFailed) {
      // The service no longer knows our token (it expired, or the service
      // was restarted on a new database). Sign in again and repeat once.
      state.token = undefined;
      if (!(await signIn())) {
        setServiceUp(false);
        return undefined;
      }

      response = await bridge.request(method, path, body, state.token);
    }

    if (response.status === 0) {
      setServiceUp(false);
      return undefined;
    }

    if (document.body.classList.contains("zo-service-down")) {
      setServiceUp(true);
      document.querySelector(".zo-notice")?.remove();
    }

    if (response.status >= 400) {
      const detail = response.body?.detail ?? `error ${response.status}`;
      notice(typeof detail === "string" ? detail : JSON.stringify(detail));
      return undefined;
    }

    return response.body;
  }

  // Same-origin read from Zulip with the page's own session.
  async function zulipGet(path, parameters) {
    const query =
      parameters === undefined ? "" : `?${new URLSearchParams(parameters)}`;
    const response = await fetch(`/json${path}${query}`, {
      credentials: "same-origin",
    });
    return response.ok ? response.json() : undefined;
  }

  // Same-origin write to Zulip, exactly as the stock page does it: the
  // session cookie plus the page's own request token. Used for adding and
  // removing an emoji reaction, and for the sign-in message to the overlay's
  // bot. Returns false when Zulip refuses, otherwise Zulip's answer.
  // `quiet` leaves a refusal unreported.
  async function zulipWrite(method, path, parameters, quiet = false) {
    const token = document.querySelector(
      'input[name="csrfmiddlewaretoken"]',
    )?.value;
    if (token === undefined) {
      notice("could not find Zulip's request token; nothing was sent");
      return false;
    }

    const response = await fetch(
      `/json${path}?${new URLSearchParams(parameters)}`,
      {
        method,
        credentials: "same-origin",
        headers: {"X-CSRFToken": token},
      },
    );
    if (!response.ok) {
      if (!quiet) {
        notice(`Zulip refused the request (${response.status})`);
      }

      return false;
    }

    return response.json();
  }

  function user(userId) {
    if (!state.users.has(userId)) {
      state.users.set(
        userId,
        zulipGet(`/users/${userId}`).then((result) => ({
          is_bot: result?.user?.is_bot ?? false,
          full_name: result?.user?.full_name ?? `user ${userId}`,
        })),
      );
    }

    return state.users.get(userId);
  }

  // One message's channel, topic and plain text, fetched from Zulip. Used
  // for a reply or thread whose parent is not on the page.
  function messageInfo(id) {
    if (!state.messages.has(id)) {
      state.messages.set(
        id,
        zulipGet(`/messages/${id}`, {apply_markdown: "false"}).then(
          (result) => {
            const message = result?.message;
            if (message === undefined || message.type !== "stream") {
              return undefined;
            }

            return {
              streamId: message.stream_id,
              topic: message.subject,
              text: plainText(message.content),
            };
          },
        ),
      );
    }

    return state.messages.get(id);
  }

  // A message's markdown source as one line of plain text, for previews:
  // without a leading reply or thread header and without markup characters.
  function plainText(markdown) {
    return markdown
      .replace(/^@_\*\*[^\n]*\]\([^\n)]*\/near\/\d+\)\s*/, "")
      .replaceAll(/@_?\*\*([^|*]*)(\|\d+)?\*\*/g, "@$1")
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replaceAll(/```[a-z]*( [^\n]*)?|\*\*|`|\$\$/g, "$1")
      .replaceAll(/\s+/g, " ")
      .trim();
  }

  function shorten(text, length) {
    return text.length > length ? `${text.slice(0, length)}\u2026` : text;
  }

  // Zulip's own encoding for names inside a #narrow URL fragment
  // (web/src/internal_url.ts).
  function encodeHashComponent(text) {
    const replacements = {
      "%": ".",
      "!": ".21",
      "'": ".27",
      "(": ".28",
      ")": ".29",
      "*": ".2A",
      ".": ".2E",
    };
    return encodeURIComponent(text).replaceAll(
      /[%!'()*.]/g,
      (matched) => replacements[matched],
    );
  }

  function topicHash(streamId, topic) {
    return `#narrow/channel/${streamId}/topic/${encodeHashComponent(topic)}`;
  }

  function topicKey(streamId, topic) {
    return `${streamId}\u0000${topic}`;
  }

  // The channel id and topic of the header above a message row.
  function headerOf($row) {
    const $header = $row
      .closest(".recipient_row")
      ?.querySelector(".message_header_stream");
    if ($header === null || $header === undefined) {
      return undefined;
    }

    return {
      streamId: Number($header.dataset.streamId),
      topic: $header.dataset.topicName,
    };
  }

  // A topic has no id in Zulip, so the overlay identifies it by its first
  // message, which survives renaming, resolving and moving the topic.
  function topicAnchor(streamId, topic) {
    const key = topicKey(streamId, topic);
    if (!state.anchors.has(key)) {
      state.anchors.set(
        key,
        zulipGet("/messages", {
          anchor: "oldest",
          num_before: "0",
          num_after: "1",
          apply_markdown: "false",
          narrow: JSON.stringify([
            {operator: "channel", operand: streamId},
            {operator: "topic", operand: topic},
          ]),
        }).then((result) => result?.messages?.[0]),
      );
    }

    return state.anchors.get(key);
  }

  // ------------------------------------------------------------------ votes

  function formatScore(score) {
    return score < 0 ? `\u2212${-score}` : String(score);
  }

  function renderVotes($votes) {
    const {kind, zoId} = $votes.dataset;
    const entry = state.scores[kind].get(Number(zoId)) ?? {
      score: 0,
      my_vote: 0,
    };
    $votes.querySelector(".zo-score").textContent = formatScore(entry.score);
    $votes
      .querySelector(".zo-up")
      .classList.toggle("zo-mine", entry.my_vote === 1);
    $votes
      .querySelector(".zo-down")
      .classList.toggle("zo-mine", entry.my_vote === -1);
    $votes.classList.toggle(
      "zo-active",
      entry.score !== 0 || entry.my_vote !== 0,
    );
  }

  function renderAllVotes(kind, id) {
    if (kind === "message") {
      const score = state.scores.message.get(id)?.score ?? 0;
      for (const $static of document.querySelectorAll(
        `.zo-static-score[data-zo-id="${id}"]`,
      )) {
        $static.textContent =
          score === 0
            ? ""
            : `${score > 0 ? "\u25B2" : "\u25BC"} ${formatScore(score)}`;
      }
    }

    for (const $votes of document.querySelectorAll(
      `.zo-votes[data-kind="${kind}"][data-zo-id="${id}"]`,
    )) {
      renderVotes($votes);
    }
  }

  // `target` is the message that identifies what is voted on: the message
  // itself, or a topic's first message.
  async function castVote(kind, target, direction) {
    const current = state.scores[kind].get(target.id)?.my_vote ?? 0;
    const sender = await user(target.sender_id);
    const result = await service("PUT", `/votes/${kind}/${target.id}`, {
      value: current === direction ? 0 : direction,
      target: {
        stream_id: target.stream_id,
        sender_id: target.sender_id,
        sender_is_bot: sender.is_bot,
      },
    });
    if (result !== undefined) {
      state.scores[kind].set(target.id, result);
      renderAllVotes(kind, target.id);
      if (kind === "topic") {
        scheduleNest();
      }
    }
  }

  // `resolve` returns the identifying message (or undefined) when clicked.
  function buildVotes(kind, id, resolve) {
    const $votes = element("span", `zo-votes zo-votes-${kind}`);
    $votes.dataset.kind = kind;
    $votes.dataset.zoId = String(id);
    const what = kind === "topic" ? "topic" : "message";
    for (const [className, label, glyph, direction] of [
      ["zo-up", `Upvote this ${what}`, "▲", 1],
      ["zo-down", `Downvote this ${what}`, "▼", -1],
    ]) {
      const $button = element("button", className, glyph);
      $button.type = "button";
      $button.setAttribute("aria-label", label);
      $button.title = label;
      $button.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();
        const target = await resolve();
        if (target === undefined) {
          notice(
            state.metaUnavailable
              ? `Zulip did not return this ${what}'s details, so it cannot be voted on`
              : `still loading this ${what}; try again in a moment`,
          );
          return;
        }

        void castVote(kind, target, direction);
      });
      $votes.append($button);
    }

    const $score = element("span", "zo-score");
    $score.title = "Score (votes are anonymous)";
    $votes.querySelector(".zo-up").after($score);
    return $votes;
  }

  // ---------------------------------------------------------- topic headers

  async function attachHeader($header) {
    const $contents = $header.querySelector(".message-header-contents");
    if (
      $contents === null ||
      $contents.querySelector(".zo-header-slot") !== null
    ) {
      return;
    }

    const streamId = Number($header.dataset.streamId);
    const topic = $header.dataset.topicName;
    // Reserve the place now so a second scan does not add another.
    const $slot = element("span", "zo-header-slot");
    // Directly after the topic name, where the eye already is.
    const $topicName = $contents.querySelector(".stream_topic");
    if ($topicName === null) {
      $contents.append($slot);
    } else {
      $topicName.after($slot);
    }

    void findThreads(streamId, topic);

    if (!(await covers(streamId))) {
      return;
    }

    let anchor = await topicAnchor(streamId, topic);
    for (let attempt = 0; anchor === undefined && attempt < 5; attempt += 1) {
      state.anchors.delete(topicKey(streamId, topic));
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
      if (!$slot.isConnected) {
        return;
      }

      anchor = await topicAnchor(streamId, topic);
    }

    if (anchor === undefined) {
      state.anchors.delete(topicKey(streamId, topic));
      state.metaUnavailable = true;
      notice(
        `could not find the first message of "${topic}", so it cannot be voted on`,
      );
      return;
    }

    const $votes = buildVotes("topic", anchor.id, async () => anchor);
    $votes.prepend(element("span", "zo-votes-label", "Vote on topic"));
    $slot.append($votes);
    renderVotes($votes);
    queue("topic", anchor.id);
  }

  // ----------------------------------------------------- F3: nested topics

  function unresolved(name) {
    return name.startsWith(RESOLVED_PREFIX)
      ? name.slice(RESOLVED_PREFIX.length)
      : name;
  }

  function foldedSet() {
    return new Set(JSON.parse(localStorage.getItem("zo-folded") ?? "[]"));
  }

  // ---- Sorting a channel's topic list by votes -----------------------------

  const sorts = [
    ["recent", "Recent"],
    ["hot", "Hot"],
    ["top", "Most upvoted"],
    ["bottom", "Least upvoted"],
  ];

  function sortMode() {
    return localStorage.getItem("zo-sort") ?? "recent";
  }

  // What a topic is sorted by, larger first. "Hot" is the Hacker News
  // formula applied to the topic's score and the age of its latest message:
  // (score + 1) / (hours since last message + 2)^1.5. That choice is a
  // placeholder to experiment with, not a considered design.
  function sortValue(mode, streamId, name) {
    const info = state.topicInfo.get(topicKey(streamId, name));
    const score = state.scores.topic.get(info?.anchorId)?.score ?? 0;
    if (mode === "top") {
      return score;
    }

    if (mode === "bottom") {
      return -score;
    }

    const hours =
      info?.last === undefined
        ? 24 * 30
        : (Date.now() / 1000 - info.last) / 3600;
    return (score + 1) / (Math.max(hours, 0) + 2) ** 1.5;
  }

  // Load what sorting needs for the topics shown in a list: each topic's
  // first message (its identity for votes), its score, and the time of its
  // latest message.
  async function loadSortData(streamId, names) {
    const key = `${streamId}:${names.length}`;
    if (Date.now() - (state.sortChecks.get(key) ?? 0) < 30_000) {
      return;
    }

    state.sortChecks.set(key, Date.now());
    const anchors = await Promise.all(
      names.map(async (name) => topicAnchor(streamId, name)),
    );
    const ids = anchors
      .filter((anchor) => anchor !== undefined)
      .map((anchor) => anchor.id);
    const [scores, topics] = await Promise.all([
      ids.length === 0
        ? undefined
        : service("POST", "/scores", {topics: ids, messages: []}),
      zulipGet(`/users/me/${streamId}/topics`),
    ]);
    for (const [id, entry] of Object.entries(scores?.topics ?? {})) {
      state.scores.topic.set(Number(id), entry);
      renderAllVotes("topic", Number(id));
    }

    const latest = new Map(
      (topics?.topics ?? []).map((entry) => [entry.name, entry.max_id]),
    );
    const latestIds = names
      .map((name) => latest.get(name))
      .filter((id) => id !== undefined);
    const messages =
      latestIds.length === 0
        ? undefined
        : await zulipGet("/messages", {
            message_ids: JSON.stringify(latestIds),
            apply_markdown: "false",
          });
    const timeOf = new Map(
      (messages?.messages ?? []).map((message) => [
        message.id,
        message.timestamp,
      ]),
    );
    for (const [index, name] of names.entries()) {
      state.topicInfo.set(topicKey(streamId, name), {
        anchorId: anchors.at(index)?.id,
        last: timeOf.get(latest.get(name)),
      });
    }

    scheduleNest();
  }

  function sortControl($list) {
    for (const $stray of $list.querySelectorAll(":scope > .zo-sort")) {
      $stray.remove();
    }

    let $sort = $list.previousElementSibling;
    if ($sort === null || !$sort.classList.contains("zo-sort")) {
      $sort = element("div", "zo-sort");
      const $select = element("select");
      $select.title =
        "Order of this channel's topics. Sorts the topics shown here; use Zulip's 'show all topics' to sort them all.";
      for (const [value, label] of sorts) {
        const $option = element("option", undefined, label);
        $option.value = value;
        $select.append($option);
      }

      $select.value = sortMode();
      for (const type of ["click", "mousedown", "keydown"]) {
        $select.addEventListener(type, (event) => {
          event.stopPropagation();
        });
      }

      $select.addEventListener("change", () => {
        localStorage.setItem("zo-sort", $select.value);
        state.sortChecks.clear();
        $select.blur();
        scheduleNest();
      });
      $sort.append(element("span", "zo-sort-label", "Sort by"), $select);
      $list.before($sort);
    }

    // Line the control up with the topic names below it.
    const $name = $list.querySelector(
      "li.topic-list-item:not(.zo-subtopic) .sidebar-topic-name",
    );
    if ($name !== null && $name.offsetParent !== null) {
      const indent =
        $name.getBoundingClientRect().left - $list.getBoundingClientRect().left;
      $sort.style.paddingLeft = `${Math.max(indent, 0)}px`;
    }

    const $select = $sort.querySelector("select");
    if ($select.value !== sortMode()) {
      $select.value = sortMode();
    }
  }

  // Draw "A / B / C" topics as a tree in one sidebar topic list, to any
  // depth. A topic's parent is the longest "… / …" prefix of its name that is
  // itself a topic in the list. Order is changed with CSS `order`, never by
  // moving Zulip's own elements, so Zulip's re-rendering is undisturbed.
  function nestTopics($list) {
    const $items = [
      ...$list.querySelectorAll(":scope > li.topic-list-item[data-topic-name]"),
    ];
    const nesting = isOn("threads");
    const listStreamId = $items.at(0)?.querySelector("[data-stream-id]")
      ?.dataset.streamId;
    // Sorting by votes is offered once the channel is known to be one the
    // service covers; the list is drawn again when that is learned.
    const coverage =
      listStreamId === undefined
        ? false
        : state.covered.get(Number(listStreamId));
    if (listStreamId !== undefined && coverage === undefined) {
      void covers(Number(listStreamId)).then(scheduleNest);
    }

    const sorting = isOn("votes") && coverage === true;
    if (
      nesting &&
      $items.length > 0 &&
      $items[0].querySelector(".sidebar-topic-name-inner") === null
    ) {
      breakFeature("threads", "the sidebar's topic list");
      return;
    }

    if (!nesting && !sorting) {
      // Put the list back exactly as Zulip drew it.
      $list.classList.remove("zo-nested");
      if ($list.previousElementSibling?.classList.contains("zo-sort")) {
        $list.previousElementSibling.remove();
      }

      for (const $child of $list.children) {
        $child.style.removeProperty("order");
      }
    }

    const byName = new Map(
      $items.map(($item) => [unresolved($item.dataset.topicName), $item]),
    );
    const parentOf = new Map(); // Item -> parent item
    const children = new Map(); // Item -> [child items], in Zulip's order
    for (const $item of $items) {
      const name = unresolved($item.dataset.topicName);
      let $parent;
      let parentName;
      for (
        let cut = nesting ? name.lastIndexOf(SEPARATOR) : -1;
        cut > 0 && $parent === undefined;
        cut = name.lastIndexOf(SEPARATOR, cut - 1)
      ) {
        parentName = name.slice(0, cut);
        $parent = byName.get(parentName);
      }

      // Only a sub-topic's label is changed (to the part after its parent's
      // name). Zulip's own label is kept and put back otherwise.
      const $label = $item.querySelector(".sidebar-topic-name-inner");
      $item.classList.toggle("zo-subtopic", $parent !== undefined);
      if ($label !== null) {
        if ($parent !== undefined) {
          $label.dataset.zoOriginal ??= $label.textContent;
          const shown = name.slice(parentName.length + SEPARATOR.length);
          if ($label.textContent !== shown) {
            $label.textContent = shown;
          }
        } else if ($label.dataset.zoOriginal !== undefined) {
          $label.textContent = $label.dataset.zoOriginal;
          delete $label.dataset.zoOriginal;
        }
      }

      if ($parent !== undefined) {
        parentOf.set($item, $parent);
        children.set($parent, [...(children.get($parent) ?? []), $item]);
      }
    }

    if (!nesting && !sorting) {
      for (const $item of $items) {
        $item.querySelector(":scope .zo-fold")?.remove();
        $item.querySelector(":scope .zo-fold-unread")?.remove();
        $item.classList.remove("zo-folded-child");
      }

      return;
    }

    $list.classList.add("zo-nested");
    if (sorting) {
      sortControl($list);
    } else if ($list.previousElementSibling?.classList.contains("zo-sort")) {
      $list.previousElementSibling.remove();
    }

    if (sorting && listStreamId !== undefined) {
      void loadSortData(
        Number(listStreamId),
        $items.map(($item) => $item.dataset.topicName),
      );
    }

    const folded = foldedSet();
    const mode = sorting ? sortMode() : "recent";
    // Siblings in the chosen order: by votes, or as Zulip listed them.
    const ranked = ($siblings) => {
      if (mode === "recent") {
        return $siblings;
      }

      const valueOf = new Map(
        $siblings.map(($item) => [
          $item,
          sortValue(mode, Number(listStreamId), $item.dataset.topicName),
        ]),
      );
      return [...$siblings].sort(($a, $b) => valueOf.get($b) - valueOf.get($a));
    };

    // Unread messages in a topic and everything nested under it.
    const unreadBelow = ($item) => {
      let total = 0;
      for (const $kid of children.get($item) ?? []) {
        total +=
          Number($kid.querySelector(".unread_count")?.textContent.trim()) || 0;
        total += unreadBelow($kid);
      }

      return total;
    };

    let order = 0;
    const place = ($item, depth, hidden) => {
      $item.style.order = String(order);
      order += 1;
      $item.style.setProperty("--zo-depth", String(depth));
      $item.classList.toggle("zo-folded-child", hidden);
      const $kids = children.get($item) ?? [];
      const streamId =
        $item.querySelector("[data-stream-id]")?.dataset.streamId;
      const foldKey = topicKey(
        streamId,
        unresolved($item.dataset.topicName ?? ""),
      );
      const isFolded = folded.has(foldKey);
      let $fold = $item.querySelector(":scope .zo-fold");
      // A folded parent carries the unread count of what it hides.
      const hiddenUnread =
        isFolded && $kids.length > 0 ? unreadBelow($item) : 0;
      let $unread = $item.querySelector(":scope .zo-fold-unread");
      if (hiddenUnread === 0) {
        $unread?.remove();
      } else {
        if ($unread === null) {
          $unread = element("span", "zo-fold-unread");
          $unread.title = "Unread messages in the sub-topics folded here";
          $item.querySelector(".topic-markers-and-unreads")?.prepend($unread);
        }

        const text = `+${hiddenUnread}`;
        if ($unread.textContent !== text) {
          $unread.textContent = text;
        }
      }

      if ($kids.length === 0) {
        $fold?.remove();
      } else {
        if ($fold === null) {
          $fold = element("span", "zo-fold");
          $fold.addEventListener("click", (event) => {
            event.stopPropagation();
            event.preventDefault();
            const next = foldedSet();
            if (!next.delete(foldKey)) {
              next.add(foldKey);
            }

            localStorage.setItem("zo-folded", JSON.stringify([...next]));
            nestTopics($list);
          });
          $item.append($fold);
        }

        // Sit in the gutter just left of the topic's name, so names stay
        // aligned whether or not a topic has sub-topics.
        const $name = $item.querySelector(".sidebar-topic-name");
        if ($name !== null && $name.offsetParent !== null) {
          const nameBox = $name.getBoundingClientRect();
          const itemBox = $item.getBoundingClientRect();
          $fold.style.left = `${nameBox.left - itemBox.left - 17}px`;
          $fold.style.top = `${nameBox.top - itemBox.top}px`;
          $fold.style.height = `${nameBox.height}px`;
        }

        const glyph = isFolded ? "\u25B6" : "\u25BC";
        if ($fold.textContent !== glyph) {
          $fold.textContent = glyph;
        }
        $fold.title = isFolded
          ? `Show ${$kids.length} ${$kids.length === 1 ? "sub-topic" : "sub-topics"}`
          : "Hide sub-topics";
      }

      for (const $kid of ranked($kids)) {
        place($kid, depth + 1, hidden || isFolded);
      }
    };

    // Top-level topics in the chosen order; each one's sub-topics follow it.
    const topicSet = new Set($items);
    const roots = [...$list.children].filter(
      ($child) => !parentOf.has($child) && !("zo" in $child.dataset),
    );
    const topicRoots = ranked(roots.filter(($child) => topicSet.has($child)));

    for (const $root of [
      ...topicRoots,
      ...roots.filter(($child) => !topicSet.has($child)),
    ]) {
      place($root, 0, false);
    }
  }

  function nestAll() {
    for (const $list of document.querySelectorAll("ul.topic-list")) {
      nestTopics($list);
    }
  }

  // For callers that are not reacting to a page change (new data arrived).
  function scheduleNest() {
    state.nestTimer ??= setTimeout(() => {
      state.nestTimer = undefined;
      nestAll();
    }, 100);
  }

  // ---- Threads: a sub-topic started from one message ----------------------
  //
  // A thread is an ordinary Zulip topic named "Parent / Child" whose first
  // message opens with a link back to the message it branched from:
  //   @_**Author|id** [thread from this message](…/near/<message id>)
  // Stock clients see a normal topic with that link. The overlay reads the
  // link to show the thread under the message it came from.

  const THREAD_LINK_TEXT = "thread from this message";

  function renderThreads(id) {
    for (const $threads of document.querySelectorAll(
      `.zo-threads[data-zo-id="${id}"]`,
    )) {
      $threads.textContent = "";
      const $row = $threads.closest(".message_row");
      const here = unresolved(
        state.meta.get(id)?.topic ??
          ($row === null ? undefined : headerOf($row)?.topic) ??
          "",
      );
      for (const thread of state.threads.get(id) ?? []) {
        // Named relative to the topic this message is in: a thread of
        // "A / B" started here in "A / B" is shown as its last part only.
        const full = unresolved(thread.topic);
        const label = full.startsWith(here + SEPARATOR)
          ? full.slice(here.length + SEPARATOR.length)
          : full;
        // A full-width row, slightly indented: it reads as part of the
        // conversation, the way a thread does in Discord.
        const $card = element("a", "zo-thread-card");
        $card.href = topicHash(thread.streamId, thread.topic);
        $card.title = `Open the thread "${thread.topic}"`;
        $card.addEventListener("click", (event) => {
          event.stopPropagation();
        });
        const $head = element("span", "zo-thread-head");
        $head.append(
          element("span", "zo-thread-kicker", "Thread"),
          element("span", "zo-thread-name", label),
          element("span", "zo-thread-open", "Open thread \u2192"),
        );
        $card.append($head);
        if (thread.preview !== "") {
          $card.append(
            element(
              "span",
              "zo-thread-preview",
              thread.startedBy === ""
                ? thread.preview
                : `${thread.startedBy}: ${thread.preview}`,
            ),
          );
        }

        $threads.append($card);
      }
    }
  }

  // Find the threads that branch from messages of this topic: list the
  // channel's topics, keep those named "<root> / …", and read the link at the
  // top of each one's first message.
  async function findThreads(streamId, topic) {
    const root = unresolved(topic);
    const key = topicKey(streamId, root);
    const checked = state.threadChecks.get(key) ?? 0;
    if (Date.now() - checked < 30_000) {
      return;
    }

    state.threadChecks.set(key, Date.now());
    const result = await zulipGet(`/users/me/${streamId}/topics`);
    const names = (result?.topics ?? [])
      .map((entry) => entry.name)
      .filter((name) => unresolved(name).startsWith(root + SEPARATOR));
    const found = await Promise.all(
      names.map(async (name) => ({
        name,
        first: await topicAnchor(streamId, name),
      })),
    );
    const touched = new Set();
    for (const {name, first} of found) {
      const match = /\/near\/(\d+)\)/.exec(
        (first?.content ?? "").split("\n")[0],
      );
      if (match === null) {
        continue; // A plain sub-topic, not started from a message.
      }

      const sourceId = Number(match[1]);
      const list = state.threads.get(sourceId) ?? [];
      if (!list.some((thread) => thread.topic === name)) {
        const body = plainText(first.content);
        list.push({
          streamId,
          topic: name,
          startedBy: first.sender_full_name,
          preview: shorten(body, 160),
        });
        state.threads.set(sourceId, list);
        touched.add(sourceId);
      }
    }

    for (const id of touched) {
      renderThreads(id);
    }
  }

  // Open Zulip's own compose box on a new topic "Parent / Child" with the
  // link back to the source message at the top. The user writes and sends
  // the first message themselves.
  function startThread(id, childName) {
    const meta = state.meta.get(id);
    const name = `${unresolved(meta.topic)}${SEPARATOR}${childName.trim()}`;
    if ([...name].length > MAX_TOPIC_LENGTH) {
      notice(
        `"${name}" is ${[...name].length} characters; Zulip allows ${MAX_TOPIC_LENGTH}. Use a shorter name`,
      );
      return;
    }

    const $new = document.querySelector("#new_conversation_button");
    if ($new === null) {
      notice("could not find Zulip's new-conversation button");
      return;
    }

    if (currentStreamId() !== meta.stream_id) {
      location.hash = `#narrow/channel/${meta.stream_id}`;
    }

    setTimeout(() => {
      $new.click();
      setTimeout(() => {
        const $topic = document.querySelector(
          "#stream_message_recipient_topic",
        );
        const $textarea = document.querySelector("#compose-textarea");
        if (
          $topic === null ||
          $textarea === null ||
          $topic.offsetParent === null
        ) {
          notice("Zulip's compose box did not open, so no thread was started");
          return;
        }

        $topic.value = name;
        $topic.dispatchEvent(new Event("input", {bubbles: true}));
        const link = `${location.origin}/${topicHash(meta.stream_id, meta.topic)}/near/${id}`;
        $textarea.value = `@_**${meta.sender_name}|${meta.sender_id}** [${THREAD_LINK_TEXT}](${link})\n\n`;
        $textarea.dispatchEvent(new Event("input", {bubbles: true}));
        $textarea.focus();
        // The new thread should show up under its message once sent.
        state.threadChecks.delete(
          topicKey(meta.stream_id, unresolved(meta.topic)),
        );
      }, 200);
    }, 200);
  }

  function askThreadName($button, id) {
    if (state.meta.get(id) === undefined) {
      notice("still loading this message; try again in a moment");
      return;
    }

    // The whole name "Parent / name" must fit Zulip's topic limit, so the
    // box takes no more characters than are left.
    const parent = unresolved(state.meta.get(id).topic);
    const room = MAX_TOPIC_LENGTH - [...parent].length - SEPARATOR.length;
    if (room < 1) {
      notice(
        `"${parent}" is too long to hold a thread: Zulip allows ${MAX_TOPIC_LENGTH} characters for the whole name`,
      );
      return;
    }

    document.querySelector(".zo-ask")?.remove();
    const $ask = element("span", "zo-ask");
    const $input = element("input");
    $input.type = "text";
    $input.maxLength = room;
    $input.placeholder = "Thread name, then Enter";
    const $room = element("span", "zo-ask-room", String(room));
    $room.title = "Characters left in Zulip's topic name";
    $input.addEventListener("input", () => {
      $room.textContent = String(room - [...$input.value].length);
    });
    for (const type of ["click", "mousedown", "keyup", "keypress"]) {
      $input.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    }

    $input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        $ask.remove();
      }

      if (event.key === "Enter" && $input.value.trim() !== "") {
        $ask.remove();
        startThread(id, $input.value);
      }
    });
    $ask.append($input, $room);
    $button.after($ask);
    $input.focus();
  }

  // ------------------------------------------------------------ F2: replies

  // A reply is an ordinary message whose first paragraph is only a silent
  // mention of the parent's author and a link to the parent message. Zulip's
  // own quote-and-reply produces the same shape, followed by a quote block.
  function replyHeader($content) {
    const $first = [...$content.children].find(
      ($child) => !("zo" in $child.dataset),
    );
    if (
      $first === undefined ||
      $first.tagName !== "P" ||
      !$first.firstElementChild?.classList.contains("user-mention")
    ) {
      return undefined;
    }

    const $mention = $first.firstElementChild;
    const $link = $first.querySelector('a[href*="/near/"]');
    if ($link === null) {
      return undefined;
    }

    const rest = $first.textContent
      .replace($mention.textContent, "")
      .replace($link.textContent, "")
      .trim();
    const match =
      /\/(?:channel|stream)\/(\d+)[^/]*\/topic\/([^/]+)\/near\/(\d+)/.exec(
        $link.getAttribute("href"),
      );
    if (match === null || (rest !== "" && rest !== ":")) {
      return undefined;
    }

    return {
      $first,
      // The first message of a thread links to the message it branched from.
      isThread: $link.textContent === THREAD_LINK_TEXT,
      author: $mention.textContent.replace(/^@/, ""),
      href: $link.getAttribute("href"),
      streamId: Number(match[1]),
      topicEncoded: match[2],
      parentId: Number(match[3]),
    };
  }

  // The visible text of a message, without a reply header or collapsed quote.
  function snippetText($content) {
    const $copy = $content.cloneNode(true);
    for (const $skip of $copy.querySelectorAll(
      "[data-zo], .zo-reply-header, .zo-thread-header, .zo-quote, .katex-mathml",
    )) {
      $skip.remove();
    }

    return $copy.textContent.replaceAll(/\s+/g, " ").trim();
  }

  function markReply($row, id) {
    const $content = $row.querySelector(".message_content");
    const header = replyHeader($content);
    const here = headerOf($row);
    if (header === undefined || here === undefined) {
      return;
    }

    const $quote =
      header.$first.nextElementSibling?.tagName === "BLOCKQUOTE"
        ? header.$first.nextElementSibling
        : undefined;
    header.$first.classList.add(
      header.isThread ? "zo-thread-header" : "zo-reply-header",
    );
    if ($quote !== undefined && !$quote.classList.contains("zo-quote")) {
      $quote.classList.add("zo-quote", "zo-quote-collapsed");
      $quote.title = "Click to show or hide the quoted text";
      $quote.addEventListener("click", (event) => {
        event.stopPropagation();
        $quote.classList.toggle("zo-quote-collapsed");
      });
    }

    const $chip =
      $content.querySelector(":scope > .zo-reply-chip") ??
      element("a", "zo-reply-chip");
    const isNew = !$chip.isConnected;
    const $parentRow = document.querySelector(
      `.message_row[data-message-id="${header.parentId}"]`,
    );
    // Same topic if the parent is drawn under this very header, or the link
    // names this topic. A renamed topic makes the link stale, so a parent we
    // cannot see is looked up below before saying "in another topic".
    const parentHere = $parentRow === null ? undefined : headerOf($parentRow);
    let sameTopic =
      !header.isThread &&
      (parentHere === undefined
        ? header.streamId === here.streamId &&
          header.topicEncoded === encodeHashComponent(here.topic)
        : parentHere.streamId === here.streamId &&
          parentHere.topic === here.topic);
    const draw = (snippet, elsewhere) => {
      const lead = header.isThread
        ? `\u2934 Thread from ${header.author}`
        : `\u21A9 ${header.author}${elsewhere ? " (in another topic)" : ""}`;
      const text = `${lead}${snippet === "" ? "" : `: ${shorten(snippet, 90)}`}`;
      if ($chip.textContent !== text) {
        $chip.textContent = text;
      }
    };

    if (sameTopic) {
      state.parents.set(id, header.parentId);
    }

    if (header.isThread) {
      $chip.classList.add("zo-thread-origin");
      registerThread(id, header.parentId, here, $content);
    }

    if (isNew) {
      $chip.href = header.href;
      $chip.title = header.isThread
        ? "Go to the message this thread started from"
        : "Go to the message this replies to";
      $chip.addEventListener("click", (event) => {
        const $parent = document.querySelector(
          `.message_row[data-message-id="${header.parentId}"]`,
        );
        if ($parent !== null) {
          event.preventDefault();
          event.stopPropagation();
          $parent.scrollIntoView({block: "center", behavior: "smooth"});
          $parent.classList.add("zo-flash");
          setTimeout(() => {
            $parent.classList.remove("zo-flash");
          }, 1500);
        }
      });
      draw(
        $parentRow === null
          ? ""
          : snippetText($parentRow.querySelector(".message_content")),
        false,
      );
      $content.prepend($chip);
      if ($parentRow === null) {
        void messageInfo(header.parentId).then((info) => {
          if (info === undefined) {
            draw("", !header.isThread && !sameTopic);
            return;
          }

          if (
            !header.isThread &&
            info.streamId === here.streamId &&
            info.topic === headerOf($row)?.topic
          ) {
            sameTopic = true;
            state.parents.set(id, header.parentId);
            renderReplyCounts();
          }

          draw(info.text, !header.isThread && !sameTopic);
        });
      }
    }
  }

  // A thread's first message is on the page: show the thread under its
  // source message now, without waiting for the next lookup of the channel's
  // topics.
  function registerThread(id, sourceId, here, $content) {
    const list = state.threads.get(sourceId) ?? [];
    if (list.some((thread) => thread.topic === here.topic)) {
      return;
    }

    const meta = state.meta.get(id);
    list.push({
      streamId: here.streamId,
      topic: here.topic,
      startedBy: meta?.sender_name ?? "",
      preview: shorten(snippetText($content), 160),
    });
    state.threads.set(sourceId, list);
    renderThreads(sourceId);
  }

  function renderReplyCounts() {
    const counts = new Map();
    for (const parentId of state.parents.values()) {
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    }

    for (const $count of document.querySelectorAll(".zo-reply-count")) {
      const count = counts.get(Number($count.dataset.zoId)) ?? 0;
      $count.textContent =
        count === 0 ? "" : `${count} ${count === 1 ? "reply" : "replies"}`;
    }
  }

  // Open Zulip's own compose box as a reply in this topic and put the reply
  // header at the top. The user writes and sends the message themselves.
  function startReply($row, id) {
    const meta = state.meta.get(id);
    if (meta === undefined) {
      notice("still loading this message; try again in a moment");
      return;
    }

    // Clicking a message is how stock Zulip opens its reply compose box.
    $row
      .querySelector(".messagebox")
      .dispatchEvent(new MouseEvent("click", {bubbles: true}));
    setTimeout(() => {
      const $textarea = document.querySelector("#compose-textarea");
      if ($textarea === null || $textarea.offsetParent === null) {
        notice("Zulip's compose box did not open, so no reply was started");
        return;
      }

      const link = `${location.origin}/${topicHash(meta.stream_id, meta.topic)}/near/${id}`;
      const header = `@_**${meta.sender_name}|${meta.sender_id}** [↩](${link})\n\n`;
      if (!$textarea.value.startsWith(header)) {
        $textarea.value = header + $textarea.value;
        $textarea.dispatchEvent(new Event("input", {bubbles: true}));
      }

      $textarea.focus();
      $textarea.setSelectionRange(
        $textarea.value.length,
        $textarea.value.length,
      );
    }, 150);
  }

  // -------------------------------------------------- F4: one-click reactions

  async function toggleReaction($row, id, name, code) {
    const reacted =
      $row.querySelector(
        `.message_reaction.reacted[data-reaction-id="unicode_emoji,${code}"]`,
      ) !== null;
    // Zulip's own event stream redraws the reaction; nothing to draw here.
    await zulipWrite(reacted ? "DELETE" : "POST", `/messages/${id}/reactions`, {
      emoji_name: name,
    });
    setTimeout(() => {
      markReacted($row);
    }, 700);
  }

  const quickHandlers = new WeakMap(); // .zo-quick element -> its onPick

  function fillQuick($quick) {
    $quick.replaceChildren(...emojiButtons(quickHandlers.get($quick)));
    const $row = $quick.closest(".message_row");
    if ($row !== null) {
      markReacted($row);
    }
  }

  // Show which of the one-click emoji this user has already reacted with.
  function markReacted($row) {
    for (const $button of $row.querySelectorAll(".zo-quick .zo-emoji")) {
      $button.classList.toggle(
        "zo-mine",
        $row.querySelector(
          `.message_reaction.reacted[data-reaction-id="unicode_emoji,${$button.dataset.code}"]`,
        ) !== null,
      );
    }
  }

  function emojiButtons(onPick) {
    return quickEmoji().map(([name, code, glyph]) => {
      const $button = element("button", "zo-emoji", glyph);
      $button.type = "button";
      $button.dataset.code = code;
      $button.title = `:${name}:`;
      $button.addEventListener("mousedown", (event) => {
        // Keep the text selection alive for inline reactions.
        event.preventDefault();
      });
      $button.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        onPick(name, code);
      });
      return $button;
    });
  }

  // ------------------------------------------------- F5: inline reactions

  // The message's displayed text as a list of pieces with offsets: its text
  // nodes, and each rendered formula as one piece whose text is its TeX
  // source (a formula's own text is duplicated and scrambled in the page).
  // Skips everything the overlay added.
  function textNodes($content) {
    const nodes = [];
    let offset = 0;
    const add = (node, text, atomic) => {
      nodes.push({node, start: offset, length: text.length, text, atomic});
      offset += text.length;
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        add(node, node.data, false);
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE || "zo" in node.dataset) {
        return;
      }

      if (node.classList.contains("katex")) {
        const tex =
          node.querySelector('annotation[encoding="application/x-tex"]')
            ?.textContent ?? node.textContent;
        add(node, tex, true);
        return;
      }

      for (const child of node.childNodes) {
        walk(child);
      }
    };

    walk($content);
    return {nodes, text: nodes.map(({text}) => text).join("")};
  }

  // A short non-cryptographic digest of a passage (two FNV-1a passes). The
  // service stores this, never the passage.
  function digest(text) {
    let a = 0x81_1c_9d_c5;
    let b = 0x01_00_01_93;
    for (const character of text) {
      const code = character.codePointAt(0);
      a = Math.imul(a ^ code, 0x01_00_01_93);
      b = Math.imul(b ^ code, 0x81_1c_9d_c5) + 0x9e_37;
    }

    return (
      (a >>> 0).toString(16).padStart(8, "0") +
      (b >>> 0).toString(16).padStart(8, "0")
    );
  }

  // Where a stored passage is now: its recorded position if the text there
  // still matches, otherwise the first passage of the same length with the
  // same digest (the message was edited), otherwise nowhere.
  function locate(text, reaction) {
    const length = reaction.end - reaction.start;
    if (digest(text.slice(reaction.start, reaction.end)) === reaction.hash) {
      return reaction.start;
    }

    for (let start = 0; start + length <= text.length; start += 1) {
      if (digest(text.slice(start, start + length)) === reaction.hash) {
        return start;
      }
    }

    return undefined;
  }

  function clearInline($content) {
    for (const $badge of $content.querySelectorAll(".zo-inline-badges")) {
      $badge.remove();
    }

    for (const $mark of $content.querySelectorAll("mark.zo-inline")) {
      $mark.replaceWith(...$mark.childNodes);
    }

    for (const $math of $content.querySelectorAll(".katex.zo-inline")) {
      $math.classList.remove("zo-inline");
    }

    $content.normalize();
  }

  async function namesTitle(reaction) {
    const people = await Promise.all(
      reaction.user_ids.map(async (id) => (await user(id)).full_name),
    );
    return `:${reaction.emoji}: ${people.join(", ")}`;
  }

  function renderInline($row, id) {
    const $content = $row.querySelector(".message_content");
    clearInline($content);
    const reactions = state.inline.get(id) ?? [];
    // Group the reactions by passage, in order of position.
    const passages = new Map();
    for (const reaction of reactions) {
      const key = `${reaction.start}-${reaction.end}-${reaction.hash}`;
      passages.set(key, [...(passages.get(key) ?? []), reaction]);
    }

    // Later passages first, so earlier offsets stay valid while wrapping.
    for (const group of [...passages.values()].reverse()) {
      const {nodes, text} = textNodes($content);
      const start = locate(text, group[0]);
      if (start === undefined) {
        continue; // The passage is gone; the reaction is no longer shown.
      }

      const end = start + (group[0].end - group[0].start);
      let $last;
      for (const {node, start: nodeStart, length, atomic} of nodes) {
        const from = Math.max(start, nodeStart) - nodeStart;
        const to = Math.min(end, nodeStart + length) - nodeStart;
        if (from >= to) {
          continue;
        }

        if (atomic) {
          node.classList.add("zo-inline");
          // Display math sits in a block; put the badge after the block.
          $last = node.closest(".katex-display") ?? node;
          continue;
        }

        // The line breaks between paragraphs are text too; wrapping them
        // would put an inline box between blocks and shift the layout.
        if (node.data.slice(from, to).trim() === "") {
          continue;
        }

        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const $mark = document.createElement("mark");
        $mark.className = "zo-inline";
        range.surroundContents($mark);
        $last = $mark;
      }

      if ($last === undefined) {
        continue;
      }

      const $badges = element("span", "zo-inline-badges");
      for (const reaction of group) {
        const $badge = element(
          "button",
          `zo-inline-badge${reaction.mine ? " zo-mine" : ""}`,
          `${glyphOf.get(reaction.emoji) ?? `:${reaction.emoji}:`} ${reaction.user_ids.length}`,
        );
        $badge.type = "button";
        $badge.addEventListener("mouseenter", async () => {
          $badge.title = await namesTitle(reaction);
        });
        $badge.addEventListener("click", (event) => {
          event.stopPropagation();
          event.preventDefault();
          void putInline(id, reaction, !reaction.mine);
        });
        $badges.append($badge);
      }

      $last.after($badges);
    }
  }

  async function putInline(id, passage, on) {
    const result = await service("PUT", `/inline/${id}`, {
      start: passage.start,
      end: passage.end,
      hash: passage.hash,
      emoji: passage.emoji,
      on,
    });
    if (result === undefined) {
      return;
    }

    state.inline.set(id, result.reactions);
    for (const $row of document.querySelectorAll(
      `.message_row[data-message-id="${id}"]`,
    )) {
      renderInline($row, id);
    }
  }

  // The selected passage, if the selection lies inside one channel message.
  function selectedPassage() {
    const selection = getSelection();
    if (
      selection === null ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      return undefined;
    }

    const range = selection.getRangeAt(0);
    const $common =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const $content = $common.closest(".message_content");
    const $row = $content?.closest(".message_row[data-message-id]");
    if (
      $row === null ||
      $row === undefined ||
      $row.classList.contains("private-message") ||
      $row.dataset.zoUncovered !== undefined
    ) {
      return undefined;
    }

    // The pieces the selection touches. A piece cut by the selection's edge
    // counts from that edge, except a formula, which is taken whole.
    const {nodes, text} = textNodes($content);
    const touched = nodes.filter(({node}) => range.intersectsNode(node));
    if (touched.length === 0) {
      return undefined;
    }

    const first = touched[0];
    const last = touched.at(-1);
    const start =
      first.start +
      (!first.atomic && first.node === range.startContainer
        ? range.startOffset
        : 0);
    const end =
      last.start +
      (!last.atomic && last.node === range.endContainer
        ? range.endOffset
        : last.length);
    if (start >= end || text.slice(start, end).trim() === "") {
      return undefined;
    }

    return {
      id: Number($row.dataset.messageId),
      start,
      end,
      hash: digest(text.slice(start, end)),
      rect: range.getBoundingClientRect(),
    };
  }

  function showSelectionBar() {
    document.querySelector(".zo-select-bar")?.remove();
    if (
      document.body.classList.contains("zo-service-down") ||
      !isOn("inline")
    ) {
      return;
    }

    const passage = selectedPassage();
    if (passage === undefined || !Number.isInteger(passage.id)) {
      return;
    }

    const $bar = element("div", "zo-select-bar");
    $bar.title = "React to the selected passage";
    $bar.append(
      ...emojiButtons((name) => {
        $bar.remove();
        getSelection().removeAllRanges();
        void putInline(passage.id, {...passage, emoji: name}, true);
      }),
    );
    $bar.style.left = `${Math.max(8, passage.rect.left)}px`;
    $bar.style.top = `${Math.max(8, passage.rect.top - 38)}px`;
    document.body.append($bar);
  }

  // ------------------------------------------------------ time-gap dividers

  function describeGap(seconds) {
    const hours = seconds / 3600;
    if (hours < 1) {
      return `${Math.round(seconds / 60)} min later`;
    }

    if (hours < 48) {
      return `${Math.round(hours)} h later`;
    }

    return `${Math.round(hours / 24)} days later`;
  }

  function markGaps($group) {
    let previous;
    for (const $row of $group.querySelectorAll(
      ":scope > .message_row[data-message-id]",
    )) {
      const meta = state.meta.get(Number($row.dataset.messageId));
      if (meta === undefined) {
        previous = undefined;
        continue;
      }

      const gap = previous === undefined ? 0 : meta.timestamp - previous;
      // Zulip already draws its own divider when the date changes.
      const hasDateDivider =
        $row.querySelector(":scope > .message_feed_divider") !== null;
      if (gap > settings().gapMinutes * 60 && !hasDateDivider) {
        $row.classList.add("zo-gap");
        $row.dataset.zoGap = describeGap(gap);
        // Start the divider where the message text starts.
        const $content = $row.querySelector(".message_content");
        if ($content !== null && $content.offsetParent !== null) {
          $row.style.setProperty(
            "--zo-indent",
            `${$content.getBoundingClientRect().left - $row.getBoundingClientRect().left}px`,
          );
        }
      } else {
        $row.classList.remove("zo-gap");
      }

      previous = meta.timestamp;
    }
  }

  // -------------------------------------------------- batched data fetching

  async function flush() {
    state.flushTimer = undefined;
    const queued = [...state.pending];
    state.pending.clear();
    const ids = {message: [], topic: []};
    for (const entry of queued) {
      const [kind, id] = entry.split(":");
      ids[kind].push(Number(id));
    }

    const needMeta = ids.message.filter((id) => !state.meta.has(id));
    const served = ids.message.filter((id) => !state.uncovered.has(id));
    const [scores, inline, messages] = await Promise.all([
      ids.topic.length + served.length === 0
        ? undefined
        : service("POST", "/scores", {topics: ids.topic, messages: served}),
      served.length === 0
        ? undefined
        : service("POST", "/inline/query", {ids: served}),
      needMeta.length === 0
        ? undefined
        : zulipGet("/messages", {
            message_ids: JSON.stringify(needMeta),
            apply_markdown: "false",
            client_gravatar: "true",
          }),
    ]);

    if (needMeta.length > 0) {
      state.metaUnavailable = messages === undefined;
    }

    for (const message of messages?.messages ?? []) {
      if (message.type === "stream") {
        state.meta.set(message.id, {
          id: message.id,
          stream_id: message.stream_id,
          topic: message.subject,
          sender_id: message.sender_id,
          sender_name: message.sender_full_name,
          timestamp: message.timestamp,
        });
      }
    }

    for (const [kind, plural] of [
      ["topic", "topics"],
      ["message", "messages"],
    ]) {
      for (const [id, entry] of Object.entries(scores?.[plural] ?? {})) {
        state.scores[kind].set(Number(id), entry);
        renderAllVotes(kind, Number(id));
      }
    }

    for (const [id, reactions] of Object.entries(inline?.reactions ?? {})) {
      state.inline.set(Number(id), reactions);
      if (reactions.length > 0) {
        for (const $row of document.querySelectorAll(
          `.message_row[data-message-id="${id}"]`,
        )) {
          renderInline($row, Number(id));
        }
      }
    }

    for (const $group of document.querySelectorAll(".recipient_row")) {
      markGaps($group);
    }
  }

  function queue(kind, id) {
    state.pending.add(`${kind}:${id}`);
    state.flushTimer ??= setTimeout(() => {
      void flush();
    }, 150);
  }

  // ---------------------------------------------------------- message rows

  // What every feature needs: a message row with its box and its text.
  function structureIsKnown($row) {
    return (
      $row.querySelector(".messagebox .messagebox-content") !== null &&
      $row.querySelector(".message_content") !== null
    );
  }

  // What single features need beyond that. Checked once, on the first
  // channel message drawn; a feature whose elements are missing turns itself
  // off and the others carry on.
  function checkFeatures($row) {
    const $group = $row.closest(".recipient_row");
    if (
      $group?.querySelector(
        ".message_header_stream[data-stream-id] .message-header-contents",
      ) === null
    ) {
      breakFeature("votes", "the topic header");
    }

    if (document.querySelector("#compose-textarea") === null) {
      breakFeature("replies", "the compose box");
      breakFeature("threads", "the compose box");
    }

    if (document.querySelector('input[name="csrfmiddlewaretoken"]') === null) {
      breakFeature("reactions", "the request token");
    }
  }

  function attach($row) {
    if (state.disabled) {
      return;
    }

    if (!state.structureChecked) {
      state.structureChecked = true;
      if (!structureIsKnown($row)) {
        state.disabled = true;
        notice(
          "Zulip's page layout has changed; overlay features are off until the app is updated",
        );
        return;
      }
    }

    // Locally echoed messages carry a temporary fractional id; Zulip redraws
    // the row with the real id once the server confirms it.
    const id = Number($row.dataset.messageId);
    if (!Number.isInteger(id) || $row.classList.contains("private-message")) {
      return;
    }

    const $box = $row.querySelector(".messagebox-content");
    if ($box === null || $box.querySelector(":scope > .zo-meta") !== null) {
      return;
    }

    if (!state.featuresChecked) {
      state.featuresChecked = true;
      checkFeatures($row);
    }

    // Two separate pieces, so nothing moves when the pointer arrives:
    //   .zo-meta  in the message's own flow, below its text, always shown:
    //             thread chips, reply count, a non-zero score.
    //   .zo-bar   a toolbar that floats over the message's top edge on hover:
    //             vote, reply, thread, one-click reactions.
    const $meta = element("div", "zo-meta");
    const $static = element("span", "zo-static-score");
    $static.dataset.zoId = String(id);
    $static.title = "This message's score";
    const $bar = element("div", "zo-bar");
    const $reply = element("button", "zo-reply-button zo-on-hover", "↩ Reply");
    $reply.type = "button";
    $reply.title = "Reply to this message";
    $reply.addEventListener("click", (event) => {
      event.stopPropagation();
      startReply($row, id);
    });
    const $count = element("span", "zo-reply-count");
    $count.dataset.zoId = String(id);
    const $threads = element("span", "zo-threads");
    $threads.dataset.zoId = String(id);
    const $thread = element("button", "zo-thread-button zo-on-hover", "Thread");
    $thread.type = "button";
    $thread.title = "Start a thread (a sub-topic) from this message";
    $thread.addEventListener("click", (event) => {
      event.stopPropagation();
      askThreadName($thread, id);
    });
    const $votes = buildVotes("message", id, async () => state.meta.get(id));
    const $emoji = element("span", "zo-quick zo-on-hover");
    quickHandlers.set($emoji, (name, code) => {
      void toggleReaction($row, id, name, code);
    });
    $emoji.append(...emojiButtons(quickHandlers.get($emoji)));
    $row.addEventListener("mouseenter", () => {
      markReacted($row);
    });
    $meta.append($threads, $static, $count);
    $bar.append($votes, $reply, $thread, $emoji);
    $box.append($meta, $bar);
    renderAllVotes("message", id);
    renderVotes($votes);
    markReply($row, id);
    renderReplyCounts();
    renderThreads(id);
    if (state.inline.get(id)?.length > 0) {
      renderInline($row, id);
    }

    // Outside the channels the service covers, take the vote controls away
    // and keep this message's id from the service; the rest still needs the
    // message's details from Zulip.
    void covers(headerOf($row)?.streamId).then((covered) => {
      if (!covered) {
        state.uncovered.add(id);
        $row.dataset.zoUncovered = "";
        $votes.remove();
        $static.remove();
      }

      queue("message", id);
    });
  }

  // ------------------------------------------------------- AI spoiler tint

  const provenance = [
    ["⚫", "emoji-26ab", "zo-ai-black"],
    ["\u{1F534}", "emoji-1f534", "zo-ai-red"],
    ["\u{1F7E1}", "emoji-1f7e1", "zo-ai-yellow"],
    ["\u{1F7E2}", "emoji-1f7e2", "zo-ai-green"],
  ];

  function tint($spoiler) {
    const $header = $spoiler.querySelector(":scope > .spoiler-header");
    if ($header === null || $spoiler.classList.contains("zo-ai")) {
      return;
    }

    const text = $header.textContent.trim();
    const $firstEmoji = $header.querySelector(".emoji");
    for (const [character, emojiClass, tintClass] of provenance) {
      const startsWithEmojiSpan =
        $firstEmoji !== null &&
        $firstEmoji.classList.contains(emojiClass) &&
        text.startsWith($firstEmoji.textContent.trim());
      if (text.startsWith(character) || startsWithEmojiSpan) {
        $spoiler.classList.add("zo-ai", tintClass);
        return;
      }
    }
  }

  // The channel id of the current view, read from Zulip's URL fragment
  // (#narrow/channel/<id>-<name>/...). Undefined outside a channel view.
  function currentStreamId() {
    const match = /^#narrow\/(?:channel|stream)\/(\d+)/.exec(location.hash);
    return match === null ? undefined : Number(match[1]);
  }

  // ------------------------------------------------------------------ start

  function scan($root) {
    if (!($root instanceof Element) || $root.closest("[data-zo]") !== null) {
      return;
    }

    for (const [selector, handle] of [
      [".message_header_stream[data-stream-id]", attachHeader],
      [".message_row[data-message-id]", attach],
      [".spoiler-block", tint],
    ]) {
      if ($root.matches(selector)) {
        void handle($root);
      }

      for (const $match of $root.querySelectorAll(selector)) {
        void handle($match);
      }
    }

    if (
      $root.matches("ul.topic-list, li.topic-list-item") ||
      $root.querySelector("li.topic-list-item") !== null
    ) {
      state.nestDue = true;
    }
  }

  async function start() {
    // Not signed in (login page, logged-out view): leave the page stock.
    const me = await zulipGet("/users/me");
    if (me === undefined) {
      return;
    }

    state.userId = me.user_id;

    // Without the service only votes and inline reactions are missing; the
    // rest of the overlay starts regardless, and the service is retried.
    if (!(await signIn())) {
      setServiceUp(false);
    }

    applySettings();
    addSettingsButton();
    document.addEventListener("mousedown", (event) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(".zo-settings, .zo-settings-button") === null
      ) {
        closeSettingsPanel();
      }
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          document.querySelector(".zo-settings") !== null
        ) {
          event.stopPropagation();
          closeSettingsPanel();
        }
      },
      true,
    );
    document.addEventListener("mouseup", () => {
      // Let the browser settle the selection first.
      setTimeout(showSelectionBar, 0);
    });
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const $node of mutation.addedNodes) {
          scan($node);
        }
      }

      // Redraw the topic tree in this same step, before the browser paints,
      // so Zulip's freshly drawn full names are never visible.
      if (state.nestDue) {
        state.nestDue = false;
        nestAll();
      }

      addSettingsButton();

      // Zulip removes a channel's topic list when you leave the channel;
      // take the sort control that stood above it away too.
      for (const $sort of document.querySelectorAll(".zo-sort")) {
        if (!$sort.nextElementSibling?.matches("ul.topic-list")) {
          $sort.remove();
        }
      }
    }).observe(document.body, {childList: true, subtree: true});
    scan(document.body);
    nestAll();
  }

  globalThis.__zulipOverlay.renderThreads = renderThreads; // For the test harness.
  void start();
})();
