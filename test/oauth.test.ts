import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuthorizationRequiredError, OAuthStore } from "../src/oauth.ts";
import { ServerManager } from "../src/servers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pid-mcp-oauth-"));

test("a non-interactive connect to an OAuth server with no tokens reports needs-auth without touching the network", async () => {
  const oauth = new OAuthStore({ dir: dir(), openBrowser: () => assert.fail("must not open a browser") });
  let changes = 0;
  const manager = new ServerManager({ oauth, onStatusChange: () => changes++ });
  // Port 9 is the discard port: any real connection attempt would hang or fail differently.
  const entry = { url: "http://127.0.0.1:9/mcp", auth: "oauth" as const };
  await assert.rejects(manager.connect("meegle", entry), AuthorizationRequiredError);
  const rt = manager.runtime("meegle");
  assert.equal(rt.needsAuth, true);
  assert.equal(rt.failedAt, undefined, "needs-auth is not a failure");
  assert.match(rt.lastError ?? "", /\/mcp auth meegle/);
  assert.ok(changes >= 1);
});

test("the provider refuses to register a client with no redirect URI", () => {
  const oauth = new OAuthStore({ dir: dir() });
  const provider = oauth.providerFor("srv", { url: "https://x.example/mcp", auth: "oauth" }, new URL("https://x.example/mcp"));
  assert.throws(() => provider.clientMetadata, AuthorizationRequiredError);
  assert.throws(() => provider.redirectToAuthorization(new URL("https://x.example/auth")), AuthorizationRequiredError);
});

test("inside an interactive flow the provider carries the loopback redirect", async () => {
  const oauth = new OAuthStore({ dir: dir(), openBrowser: () => undefined });
  const end = oauth.beginInteractive("srv");
  try {
    const redirect = await oauth.ensureListener("srv");
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const provider = oauth.providerFor("srv", { url: "https://x.example/mcp", auth: "oauth" }, new URL("https://x.example/mcp"));
    assert.deepEqual(provider.clientMetadata.redirect_uris, [redirect]);
    assert.equal(provider.clientMetadata.token_endpoint_auth_method, "none");
    provider.redirectToAuthorization(new URL("https://x.example/auth?x=1"));
    assert.ok(oauth.pendingFor("srv"));
  } finally {
    end();
  }
  assert.equal(oauth.pendingFor("srv"), undefined);
});

test("configured clientId is used verbatim and stored tokens survive a restart", async () => {
  const d = dir();
  const entry = { url: "https://x.example/mcp", auth: "oauth" as const, oauth: { clientId: "cli_1", scope: "a b" } };
  const first = new OAuthStore({ dir: d }).providerFor("srv", entry, new URL(entry.url));
  assert.deepEqual(await first.clientInformation(), { client_id: "cli_1" });
  await first.saveTokens({ access_token: "t", token_type: "bearer" });
  const second = new OAuthStore({ dir: d });
  assert.equal(second.hasTokens("srv"), true);
  assert.equal((await second.providerFor("srv", entry, new URL(entry.url)).tokens())?.access_token, "t");
  second.clear("srv");
  assert.equal(second.hasTokens("srv"), false);
});
