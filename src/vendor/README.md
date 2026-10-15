# Local public-suffix parser

This directory vendors tldts 7.4.16 from its published npm ESM bundle.

Upstream: https://github.com/remusao/tldts
License: MIT (tldts.LICENSE.txt). The bundle includes its Public Suffix List data, including private suffixes.

Used solely to determine eligible cookie parent hosts and avoid requesting access to public suffixes such as co.uk or github.io. No code or data is fetched at runtime.

Update explicitly with npm install --save-dev tldts followed by node tools/vendor-tldts.mjs, then run the permission regression tests.
