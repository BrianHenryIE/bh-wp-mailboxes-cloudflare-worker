/**
 * bh-wp-mailboxes incoming email worker.
 *
 * Receives email via Cloudflare Email Routing and delivers the raw MIME
 * message to the WordPress REST API endpoint provided by the
 * bh-wp-mailboxes plugin. See PLAN.md for the design.
 */

export interface WorkerEnvironment {
  TARGET_WORDPRESS_SITE_URL: string;
  SETUP_TOKEN: string;
  WORKER_CONFIGURATION_KV: KVNamespace;
}

export default {
  // email() and fetch() handlers are implemented in later plan steps.
} satisfies ExportedHandler<WorkerEnvironment>;
