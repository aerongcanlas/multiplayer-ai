// The masking specification: every positive sample must lose each `secrets` string, and every
// negative sample must pass through unchanged. Values are fabricated and never valid anywhere.
export interface PositiveSample {
  name: string;
  text: string;
  secrets: string[];
  // Text that must survive masking, such as the variable name.
  keeps?: string[];
}

const pem = (label: string, body: string, newline = "\n") =>
  `-----BEGIN ${label}-----${newline}${body}${newline}-----END ${label}-----`;

// Fake keys are split across string literals so repository secret scanners never see a whole one.
export const POSITIVE_SAMPLES: PositiveSample[] = [
  {
    name: ".env assignment",
    text: "OPENAI_API_KEY=q8Zr2mVx4TnL7pWc",
    secrets: ["q8Zr2mVx4TnL7pWc"],
    keeps: ["OPENAI_API_KEY="],
  },
  {
    name: "exported quoted assignment",
    text: 'export DATABASE_PASSWORD="Tr0ub4dor&3horse"',
    secrets: ["Tr0ub4dor"],
    keeps: ["DATABASE_PASSWORD="],
  },
  {
    name: "PGPASSWORD",
    text: "PGPASSWORD=hunter2hunter2 psql -h db.internal",
    secrets: ["hunter2hunter2"],
    keeps: ["PGPASSWORD=", "psql -h db.internal"],
  },
  {
    name: "password flag",
    text: "mysql --password=S3cretSauce99 --user=app",
    secrets: ["S3cretSauce99"],
    keeps: ["--password="],
  },
  {
    name: "JSON key",
    text: '{"apiKey": "c2VjcmV0LXZhbHVlLTEyMw", "region": "us-east-1"}',
    secrets: ["c2VjcmV0LXZhbHVlLTEyMw"],
    keeps: ['"apiKey": "', '"region": "us-east-1"'],
  },
  {
    name: "YAML client secret",
    text: "client_secret: 9f8e7d6c5b4a3f2e1d0c",
    secrets: ["9f8e7d6c5b4a3f2e1d0c"],
    keeps: ["client_secret: "],
  },
  {
    name: "curl bearer",
    text: 'curl -H "Authorization: Bearer abc123DEF456ghi789" https://api.example.com/v1/items',
    secrets: ["abc123DEF456ghi789"],
    keeps: ["Authorization: Bearer ", "https://api.example.com/v1/items"],
  },
  {
    name: "basic header",
    text: "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
    secrets: ["dXNlcjpwYXNzd29yZDEyMw"],
    keeps: ["Authorization: Basic "],
  },
  {
    name: "api key header",
    text: "curl --header 'X-Api-Key: 5d41402abc4b2a76b9719d911017c592' https://example.com",
    secrets: ["5d41402abc4b2a76b9719d911017c592"],
    keeps: ["X-Api-Key: "],
  },
  {
    name: "cookie header",
    text: "Cookie: session=4f9a8b7c6d5e; csrftoken=11aa22bb33cc\nnext line",
    secrets: ["4f9a8b7c6d5e", "11aa22bb33cc"],
    keeps: ["Cookie: ", "next line"],
  },
  {
    name: "set-cookie header",
    text: "Set-Cookie: sid=31d4d96e407aad42; HttpOnly",
    secrets: ["31d4d96e407aad42"],
  },
  {
    name: "query token",
    text: "GET https://example.com/export?format=csv&access_token=ZXhhbXBsZXRva2Vu&page=2",
    secrets: ["ZXhhbXBsZXRva2Vu"],
    keeps: ["format=csv", "page=2"],
  },
  {
    name: "signed url",
    text: "https://bucket.example.com/f.png?X-Id=1&sig=a1b2c3d4e5f6&key=abcd",
    secrets: ["a1b2c3d4e5f6", "key=abcd"],
    keeps: ["X-Id=1"],
  },
  {
    name: "psql connection string",
    text: "psql postgres://app_user:pa55w0rdXYZ@db.example.com:5432/app",
    secrets: ["pa55w0rdXYZ"],
    keeps: ["app_user:", "@db.example.com:5432/app"],
  },
  {
    name: "libpq keyword string",
    text: "host=db.internal port=5432 password=shorty1 dbname=app",
    secrets: ["shorty1"],
    keeps: ["dbname=app"],
  },
  {
    name: "PEM block mid-line",
    text: `key is ${pem("RSA PRIVATE KEY", "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun")} end`,
    secrets: [
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
    ],
    keeps: ["key is ", " end"],
  },
  {
    name: "JSON-escaped PEM",
    text: `{"private_key": "${pem("PRIVATE KEY", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "\\n")}\\n"}`,
    secrets: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"],
  },
  {
    name: "OpenSSH key",
    text: pem(
      "OPENSSH PRIVATE KEY",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    ),
    secrets: ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"],
  },
  {
    name: "JWT",
    text: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here",
    secrets: ["eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"],
  },
  {
    name: "OpenAI key",
    text: "use sk-" + "proj4Vx9Qw2Lm8Rt5Zb1Nc7Hd3",
    secrets: ["proj4Vx9Qw2Lm8Rt5Zb1Nc7Hd3"],
    keeps: ["sk-"],
  },
  {
    name: "Anthropic key",
    text: "sk-" + "ant-api03-Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1",
    secrets: ["api03-Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1"],
  },
  {
    name: "Stripe live key",
    text: "sk_" + "live_51Hx9Zq2Lm8Rt5Zb1Nc7Hd3Kp",
    secrets: ["51Hx9Zq2Lm8Rt5Zb1Nc7Hd3Kp"],
  },
  {
    name: "Stripe restricted key",
    text: "rk_" + "live_51Hx9Zq2Lm8Rt5Zb1Nc7Hd3Kp",
    secrets: ["51Hx9Zq2Lm8Rt5Zb1Nc7Hd3Kp"],
  },
  {
    name: "Stripe webhook secret",
    text: "whs" + "ec_Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1",
    secrets: ["Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1"],
  },
  {
    name: "GitHub token",
    text: "ghp" + "_16C7e42F292c6912E7710c838347Ae178B4a",
    secrets: ["16C7e42F292c6912E7710c838347Ae178B4a"],
  },
  {
    name: "GitHub server token",
    text: "ghs" + "_16C7e42F292c6912E7710c838347Ae178B4a",
    secrets: ["16C7e42F292c6912E7710c838347Ae178B4a"],
  },
  {
    name: "GitHub fine-grained token",
    text: "git" + "hub_pat_11ABCDEFG0123456789_abcdefghijkl",
    secrets: ["11ABCDEFG0123456789_abcdefghijkl"],
  },
  {
    name: "Slack token",
    text: "xox" + "b-2048-4096-Zx8Vb7Nm6Qw5Er4T",
    secrets: ["2048-4096-Zx8Vb7Nm6Qw5Er4T"],
  },
  {
    name: "AWS access key",
    text: "aws_access_key_id AKI" + "AIOSFODNN7EXAMPLE1",
    secrets: ["IOSFODNN7EXAMPLE1"],
  },
  {
    name: "AWS session key",
    text: "ASI" + "AIOSFODNN7EXAMPLE1",
    secrets: ["IOSFODNN7EXAMPLE1"],
  },
  {
    name: "Google API key",
    text: "AIz" + "aSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
    secrets: ["SyD-9tSrke72PouQMnMX"],
  },
  {
    name: "Google OAuth token",
    text: "ya2" + "9.a0AfH6SMBx9Zq2Lm8Rt5Zb1Nc7Hd3",
    secrets: ["a0AfH6SMBx9Zq2Lm8Rt5Zb1Nc7Hd3"],
  },
  {
    name: "Supabase access token",
    text: "sbp" + "_0123456789abcdef0123456789abcdef",
    secrets: ["0123456789abcdef0123456789abcdef"],
  },
  {
    name: "Supabase secret key",
    text: "sb_" + "secret_Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1",
    secrets: ["Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1"],
  },
  {
    name: "npm token",
    text: "npm" + "_Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1As9Df0",
    secrets: ["Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1As9Df0"],
  },
  {
    name: "PyPI token",
    text: "pyp" + "i-AgEIcHlwaS5vcmcCJGExYjJjM2Q0",
    secrets: ["AgEIcHlwaS5vcmcCJGExYjJjM2Q0"],
  },
  {
    name: "Hugging Face token",
    text: "hf_" + "Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1As9Df0",
    secrets: ["Zx8Vb7Nm6Qw5Er4Ty3Ui2Op1As9Df0"],
  },
  {
    name: "SendGrid key",
    text: "SG." + "Zx8Vb7Nm6Qw5Er4Ty3Ui2.Op1As9Df0Gh8Jk7Lz6Xc5",
    secrets: ["Zx8Vb7Nm6Qw5Er4Ty3Ui2", "Op1As9Df0Gh8Jk7Lz6Xc5"],
  },
  {
    name: "Twilio key",
    text: "SK0" + "123456789abcdef0123456789abcdef",
    secrets: ["0123456789abcdef0123456789abcdef"],
  },
  {
    name: "Telegram bot token",
    text: "bot 123" + "456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1 ok",
    secrets: ["AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1"],
  },
];

export const NEGATIVE_SAMPLES: string[] = [
  "commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 fixed the build",
  "integrity sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
  '"integrity": "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="',
  "tab 3f2504e0-4f89-41d3-9a0c-0305e82c3301 is open",
  "see https://example.com/docs/getting-started?page=2&sort=asc#install",
  "postgres://db.example.com:5432/app",
  "pip install scikit-learn and sk-learn, then run task-runner and ask-before-acting",
  "Remember the password and rotate the token before the key expires.",
  "key=a and token=abc",
  "The author: Jonathan wrote the keyboard: shortcuts guide.",
  "mkdir -p src/components && cp -r a b",
  "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJ\n-----END CERTIFICATE-----",
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo\n-----END PUBLIC KEY-----",
  "Authorization is required before you continue.",
  "Use a Bearer token in the header.",
  "SKU0123 and AKI" + "A alone and ghp_short",
];
