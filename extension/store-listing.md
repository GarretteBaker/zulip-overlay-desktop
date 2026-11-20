# Chrome Web Store listing: what to enter

Draft answers for the developer dashboard's forms. Nothing here has been submitted.

## Store listing

- **Name**: Iliad Overlay (from the manifest)
- **Summary** (132 characters at most): Unofficial. Adds votes, replies, threads and inline
  reactions to the Alignment Theory Zulip organization. (from the manifest)
- **Category**: Communication (my suggestion)
- **Language**: English
- **Visibility**: Unlisted (my suggestion: it only does anything for members of one Zulip
  organization, so a public listing would only confuse other people)
- **Description**:

  > Iliad Overlay is an unofficial add-on for members of the Alignment Theory Zulip organization
  > (alignment-theory.zulipchat.com). It redraws that organization's Zulip web page to add:
  >
  > - votes on topics and messages, and sorting a channel's topics by votes
  > - a Reply button that links a message to the one it answers
  > - threads: sub-topics started from a message, folded under their parent in the sidebar
  > - one-click emoji reactions, and reactions on a selected passage of a message
  > - dividers between messages sent long apart, and tinted AI-written blocks
  >
  > It runs only on alignment-theory.zulipchat.com and does nothing on any other site. It is not
  > made or endorsed by Zulip. Source: https://github.com/GarretteBaker/zulip-overlay-desktop

- **Screenshots**: at least one, 1280×800 or 640×400. Not made yet; take it in #testing-spam.
- **Icon**: `extension/icon-128.png` is in the zip.

## Privacy practices

- **Single purpose**: Adds voting, replies, threads and reactions to one Zulip organization's web
  interface.
- **Permission justification**: the extension requests no permissions. Its content script runs
  only on `https://alignment-theory.zulipchat.com/*`, the one site it modifies.
- **Remote code**: No. All code is in the package.
- **Data use** (tick what applies):
  - *Authentication information*: yes. A token issued by the overlay service signs the user in to
    that service. The user's Zulip password and API key are never read or sent.
  - *Website content / user activity*: yes. The ids of the topics, messages and passages a user
    votes on or reacts to, and the vote or reaction, are sent to the overlay service
    (https://mcp.iliad.ac/overlay), together with the ids of public-channel messages on screen so
    their scores can be shown. No message text is sent.
  - Not sold, not used for anything but the extension's features, not used for creditworthiness.
- **Privacy policy URL**: required once any data use is ticked. None exists yet; a short page
  stating the above is needed (for example in this repository's README or on iliad.ac).

## After the first listing

The item gets an id. With that id and OAuth credentials for the Chrome Web Store API, the release
workflow can upload each new version itself; that step is not written yet.
