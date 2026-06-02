# Rewind

Rewind is a Firefox WebExtension that temporarily restores the page state you just lost after a reload, fast click-away, SPA route change, or accidental navigation.

It captures a short-lived local snapshot of visible page content and restores it in an overlay so you can recover titles, thumbnails, images, and links.

## Privacy

Rewind stores snapshots locally in your browser using browser.storage.local. It does not send page content, browsing data, or snapshots to any server.