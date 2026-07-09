# Cloudflare email routing worker to WordPress REST API

https://www.cloudflare.com/products/email-routing/

https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
https://developers.cloudflare.com/email-service/examples/email-routing/email-storage/

https://developer.wordpress.org/advanced-administration/security/application-passwords/

Goal: write a Cloudflare worker that handles incoming mail to the configured domain and forwards it to a
WordPress REST endpoint.

That REST endpoint will need authentication.

The Cloudflare worker should have a way of requesting an application password from the WordPress site and storing it.
Ideally a HTTP

Should email be stored in Cloudflare and retried for 24 hours, or should we leave that to the sending server?

Should the REST take a structured email or a flat MIME?

The worker should only be configured to send to a domain in the same DNS (e.g. p.sacramentogaa.org can incoming mail
can forward to sacramentogaa.org/wp-json/....)

The target REST endpoint needs to be configurable. Could it be discoverable?
