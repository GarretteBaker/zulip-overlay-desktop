# Iliad Overlay privacy policy

As of 20 November 2026. This covers the Iliad Overlay desktop app and browser extension, and the
overlay service they talk to at `https://mcp.iliad.ac/overlay`. Iliad Overlay is unofficial; it is
not made or endorsed by Zulip. Zulip's own handling of your data is described in Zulip's policies.

## What the app and extension do on your machine

They change how the Alignment Theory Zulip organization's web page
(`alignment-theory.zulipchat.com`) is drawn. They run on no other site. Your Zulip password and API
key are never read, stored or sent anywhere by the overlay. Settings (which features are on, your
six reaction emoji, the time-gap threshold, folded topics, the sort order) stay in your browser's
storage for that site.

## What is sent to the overlay service

Only what votes and inline reactions need:

- **Who you are.** To sign in, the overlay sends one direct message from your Zulip account to the
  bot "Overlay", containing a one-time code, and deletes it afterwards. That tells the service
  your Zulip user id. The service gives back a token, kept in your browser's storage for the Zulip
  site and sent with later requests. The token lasts 90 days.
- **Your votes.** For each vote: your Zulip user id, the id of the topic or message, and whether it
  is up or down. Other users see only the total score. The service has to record who cast each
  vote to stop double voting, so its administrator is technically able to look.
- **Your inline reactions.** Your Zulip user id, the message id, the position of the passage in the
  message, a hash of the passage, and the emoji. Other users of the overlay see your name on an
  inline reaction, as with ordinary Zulip reactions.
- **Which messages are on your screen.** To show scores, the overlay asks the service about the
  ids of the public-channel topics and messages you are looking at. These requests are not stored.

No message text is sent to or stored by the service. Nothing is sent about private channels or
direct messages, except private channels the organization has specifically enabled for testing.

The service's web server keeps ordinary request logs (time, address path, your IP address as seen
by the server) for troubleshooting.

## What is not done with it

The data is used only to provide votes and inline reactions. It is not sold, not shared with
anyone outside the people who run the service for Iliad, not used for advertising, and not used to
build profiles of anyone.

## Where it is kept, and for how long

On a server Iliad rents in Germany (Hetzner), in a database readable only by the service's own
account and the server's administrators. A copy is made daily on the same server. Votes and inline
reactions are kept until you withdraw them or ask for them to be deleted.

## Your choices

- Withdraw a vote or inline reaction in the app by clicking it again.
- Turn votes and inline reactions off in the overlay's settings (the ◧ button); the overlay then
  does not use the service for them.
- Ask for everything stored under your Zulip user id to be deleted, or for a copy of it, by
  writing to Garrett Baker on the Alignment Theory Zulip organization, or by opening an issue at
  https://github.com/GarretteBaker/zulip-overlay-desktop/issues.

## Changes

Changes to this policy are made in this file; its history is public in this repository.
