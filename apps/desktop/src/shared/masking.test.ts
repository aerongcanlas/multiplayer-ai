import test from "node:test";
import assert from "node:assert/strict";
import { maskCredentials, publishablePrefix } from "./masking";
import { NEGATIVE_SAMPLES, POSITIVE_SAMPLES } from "./masking.corpus";

test("every positive corpus sample masks and keeps its surrounding text", () => {
  for (const sample of POSITIVE_SAMPLES) {
    const masked = maskCredentials(sample.text);
    for (const secret of sample.secrets)
      assert.ok(!masked.includes(secret), `${sample.name}: ${masked}`);
    for (const kept of sample.keeps ?? [])
      assert.ok(
        masked.includes(kept),
        `${sample.name} keeps ${kept}: ${masked}`,
      );
  }
});

test("every negative corpus sample passes through unchanged", () => {
  for (const sample of NEGATIVE_SAMPLES)
    assert.equal(maskCredentials(sample), sample);
});

test("assignments and headers mask the value only; prefixed keys keep three characters", () => {
  assert.equal(
    maskCredentials("OPENAI_API_KEY=q8Zr2mVx4TnL7pWc"),
    "OPENAI_API_KEY=•••",
  );
  assert.equal(
    maskCredentials('"apiKey": "c2VjcmV0LXZhbHVl"'),
    '"apiKey": "•••"',
  );
  assert.equal(maskCredentials("PGPASSWORD=hunter2hunter2"), "PGPASSWORD=•••");
  assert.equal(maskCredentials("--password=S3cretSauce99"), "--password=•••");
  assert.equal(
    maskCredentials("Authorization: Bearer abc123DEF456"),
    "Authorization: Bearer •••",
  );
  assert.equal(
    maskCredentials("authorization: basic dXNlcjpwYXNz"),
    "authorization: basic •••",
  );
  assert.equal(
    maskCredentials("X-Api-Key: 5d41402abc4b2a76"),
    "X-Api-Key: •••",
  );
  assert.equal(maskCredentials("Cookie: a=1; b=2"), "Cookie: •••");
  assert.equal(
    maskCredentials("ghp" + "_16C7e42F292c6912E7710c838347Ae178B4a"),
    "ghp•••",
  );
});

test("query parameters mask by name only", () => {
  for (const name of [
    "token",
    "key",
    "sig",
    "secret",
    "password",
    "api_key",
    "signature",
  ])
    assert.equal(
      maskCredentials(`https://x.test/a?${name}=v4lue&page=2`),
      `https://x.test/a?${name}=•••&page=2`,
    );
  assert.equal(
    maskCredentials("https://x.test/a?keyword=v4lue"),
    "https://x.test/a?keyword=v4lue",
  );
});

test("PEM private keys mask mid-line and JSON-escaped; certificates do not", () => {
  const body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO";
  assert.ok(
    !maskCredentials(
      `a -----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY----- b`,
    ).includes(body),
  );
  assert.ok(
    !maskCredentials(
      `"-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----\\n"`,
    ).includes(body),
  );
  // A block still arriving masks to the end of the text.
  assert.ok(
    !maskCredentials(`-----BEGIN PRIVATE KEY-----\n${body}`).includes(body),
  );
  const certificate = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
  assert.equal(maskCredentials(certificate), certificate);
});

test("masking is idempotent and the placeholder never re-matches", () => {
  for (const sample of POSITIVE_SAMPLES) {
    const masked = maskCredentials(sample.text);
    assert.equal(maskCredentials(masked), masked, sample.name);
  }
});

test("streaming invariant: every extension masks to a text starting with the publishable prefix", () => {
  const texts = POSITIVE_SAMPLES.flatMap((sample) => [
    sample.text,
    `Here is the value: ${sample.text} and then more words follow.\nNext line`,
  ]);
  // Found by fuzzing: an unfinished PEM header glued to an assignment value.
  texts.push(
    "x }token: the-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfV\n",
  );
  for (const text of texts) {
    let previous = "";
    for (let length = 0; length <= text.length; length++) {
      const prefix = publishablePrefix(text.slice(0, length));
      assert.ok(
        maskCredentials(text).startsWith(prefix),
        `${JSON.stringify(text)} at ${length}: ${JSON.stringify(prefix)}`,
      );
      // Every later partial text also agrees, so a viewer's text never regresses.
      for (let later = length; later <= text.length; later += 7)
        assert.ok(
          maskCredentials(text.slice(0, later)).startsWith(prefix),
          `${JSON.stringify(text)} at ${length}/${later}`,
        );
      assert.ok(
        prefix.startsWith(previous),
        `${JSON.stringify(text)} shrank at ${length}`,
      );
      previous = prefix;
    }
  }
});

test("a header shape with its value still arriving is held back entirely", () => {
  assert.equal(
    publishablePrefix('run curl -H "Authorization: Bearer '),
    "run curl ",
  );
  assert.equal(
    publishablePrefix(
      'run curl -H "Authorization: Bearer abc123DEF456ghi789" ',
    ),
    "run curl -H ",
  );
  assert.equal(
    publishablePrefix(
      'run curl -H "Authorization: Bearer abc123DEF456ghi789" https://a.test and done ',
    ),
    'run curl -H "Authorization: Bearer •••" https://a.test and done ',
  );
  assert.equal(publishablePrefix("set OPENAI_API_KEY= "), "set ");
});

test("text ending in whitespace publishes in full; text with no whitespace publishes nothing", () => {
  assert.equal(publishablePrefix("hello world "), "hello world ");
  assert.equal(publishablePrefix("hello wor"), "hello ");
  assert.equal(publishablePrefix("sk-" + "proj4Vx9Qw2Lm8Rt5Zb1Nc7Hd3"), "");
  assert.equal(publishablePrefix(""), "");
});
