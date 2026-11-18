# basecomms legal pages

Static pages served by nginx on basecomms.com, outside the Django app.
`terms.html` is the copy deployed at `https://basecomms.com/terms`.

## Serving

`/var/www/basecomms/terms.html`, with these blocks in
`/etc/nginx/sites-available/zulip-enterprise`, next to `/privacy`:

```nginx
location = /terms {
    auth_request off;
    alias /var/www/basecomms/terms.html;
    default_type text/html;
}

location = /terms/ {
    auth_request off;
    return 301 https://$host/terms;
}
```

`/terms/` redirects instead of aliasing the file: for a location ending
in a slash, nginx looks for an index file inside the alias, and the
request fails with a 500.

## Updating

Edit `terms.html`, copy it to `/var/www/basecomms/terms.html` on the
server, and change the "Last updated" date.  No nginx reload is needed
for a content-only change.  The page links to `/privacy` and loads the
logo and favicon from `/static/images/`.
