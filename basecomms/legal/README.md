# basecomms legal pages

Static pages served by nginx on basecomms.com, outside the Django app.
`terms.html` is the copy deployed at `https://basecomms.com/terms`, and
`privacy.html` the one at `https://basecomms.com/privacy`.

## Serving

`/var/www/basecomms/terms.html` and `/var/www/basecomms/privacy.html`, with
these blocks in `/etc/nginx/sites-available/zulip-enterprise`:

```nginx
location = /privacy {
    auth_request off;
    alias /var/www/basecomms/privacy.html;
    default_type text/html;
    add_header Cache-Control "no-cache";
}

location = /terms {
    auth_request off;
    alias /var/www/basecomms/terms.html;
    default_type text/html;
    add_header Cache-Control "no-cache";
}

location = /terms/ {
    auth_request off;
    return 301 https://$host/terms;
}
```

`no-cache` makes browsers re-check the page on each visit, so an update shows
up at once.  Without a cache header a browser may reuse an old copy for days.

`/terms/` redirects instead of aliasing the file: for a location ending
in a slash, nginx looks for an index file inside the alias, and the
request fails with a 500.

## Updating

Edit the page, copy it to `/var/www/basecomms/` on the server, and change
its "Last updated" date.  No nginx reload is needed
for a content-only change.  The pages link to each other and load the
logo and favicon from `/static/images/`.
