import { SourceControlProviderKind, VcsProcessSpawnError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const processOutput = TestSourceControlHost.processOutput;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type ProcessInput = Parameters<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>[0];

const gtAccount = (host: string, fields: Record<string, unknown> = {}) => ({
  active: true,
  credential_available: true,
  credential_store: "keyring",
  error: "",
  expires_at: null,
  host,
  method: "token",
  scopes: null,
  user: "maria",
  verified: null,
  ...fields,
});

const teaLogins = encodeJson([
  { name: "work", url: "https://gitea.test", user: "maria", default: "true" },
]);

const missing = (input: ProcessInput) =>
  Effect.fail(
    new VcsProcessSpawnError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      cause: new Error(`${input.command} not found`),
    }),
  );

const withCli = (input: {
  readonly run: (
    input: ProcessInput,
  ) =>
    | Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsProcessSpawnError>
    | undefined;
  readonly fjKeys?: unknown;
  readonly requests?: string[];
}) =>
  Layer.mergeAll(
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(input.fjKeys !== undefined),
        readFileString: () => Effect.succeed(encodeJson(input.fjKeys)),
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        input.requests?.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{"via":"fj"}')));
      }),
    ),
    Layer.succeed(HostProcess.HomeDirectory, "/home/maria"),
    TestSourceControlHost.layer({
      process: {
        run: (process) =>
          input.run(process) ?? Effect.die(`Unexpected ${process.command} ${process.args[0]}`),
      },
    }),
  );

const gtStatus = (accounts: ReadonlyArray<unknown>) => (input: ProcessInput) =>
  input.command === "gt" && input.args[0] === "auth"
    ? Effect.succeed(processOutput(encodeJson(accounts)))
    : undefined;

it.effect.each([
  ["gt alone", "gt", {}],
  ["gt beside tea", "gt", { tea: true }],
  ["fj beside gt", "fj", { fj: true, tea: true }],
  ["tea when gt is missing", "tea", { gt: "missing", tea: true }],
  ["tea when gt is another tool", "tea", { gt: "other-tool", tea: true }],
] as const)("answers a Gitea request through %s", ([, expected, setup]) => {
  const options: { gt?: "missing" | "other-tool"; fj?: boolean; tea?: boolean } = setup;
  const commands: string[] = [];
  const requests: string[] = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const repository = yield* cli.resolveRepository({
      cwd: "/repo",
      repository: "https://gitea.test/maria/project",
    });
    assert.strictEqual(repository.command, expected);
    const result = yield* cli.api({
      cwd: "/repo",
      repository: "https://gitea.test/maria/project",
      path: "repos/maria/project/issues/7/comments",
      method: "POST",
      body: { body: "looks good" },
    });
    assert.strictEqual(result.stdout, `{"via":"${expected}"}`);
    assert.strictEqual(requests.length, expected === "fj" ? 1 : 0);
    assert.strictEqual(commands.includes("gt"), expected !== "fj");
  }).pipe(
    Effect.provide(
      withCli({
        requests,
        ...(options.fj
          ? { fjKeys: { hosts: { "gitea.test": { type: "Application", token: "fj-token" } } } }
          : {}),
        run: (input) => {
          commands.push(input.command);
          if (input.command === "fj") return Effect.succeed(processOutput(""));
          if (input.command === "gt") {
            if (options.gt === "missing") return missing(input);
            if (options.gt === "other-tool")
              return Effect.succeed(
                processOutput("", {
                  stderr: "unknown command auth",
                  exitCode: ChildProcessSpawner.ExitCode(input.allowNonZeroExit ? 1 : 0),
                }),
              );
            if (input.args[0] === "auth") {
              assert.deepStrictEqual(input.args, ["auth", "status", "--json"]);
              return Effect.succeed(processOutput(encodeJson([gtAccount("https://gitea.test")])));
            }
            assert.deepStrictEqual(input.args, [
              "api",
              "--no-input",
              "--include",
              "--host",
              "https://gitea.test",
              "--method",
              "POST",
              "--input",
              "-",
              "repos/maria/project/issues/7/comments",
            ]);
            assert.strictEqual(input.stdin, '{"body":"looks good"}');
            return Effect.succeed(
              processOutput('{"via":"gt"}', { stderr: "HTTP/2.0 201 Created\n" }),
            );
          }
          if (!options.tea) return missing(input);
          return Effect.succeed(
            input.args[0] === "login"
              ? processOutput(teaLogins)
              : processOutput('{"via":"tea"}', { stderr: "HTTP/1.1 201 Created\n" }),
          );
        },
      }),
    ),
  );
});

it.effect("says which CLIs to install when gt, fj and tea are all missing", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const error = yield* cli
      .api({ cwd: "/repo", host: "gitea.test", path: "user" })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "missing-cli");
    for (const name of ["`gt`", "`fj`", "`tea`"]) assert.include(error.detail, name);
  }).pipe(
    Effect.provide(
      withCli({
        run: (input) =>
          input.command === "git" ? Effect.succeed(processOutput("")) : missing(input),
      }),
    ),
  ),
);

it.effect("sends gt requests to the instance that serves each remote", () => {
  const hosts: string[] = [];
  const paths: string[] = [];
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const context = (remoteUrl: string) => ({
      provider: { kind: SourceControlProviderKind.make("forgejo"), name: "Forgejo", baseUrl: "" },
      remoteName: "origin",
      remoteUrl,
    });
    const mounted = yield* cli.resolveRepository({
      cwd: "/repo",
      context: context("https://example.com/gitea/maria/project.git"),
    });
    assert.deepStrictEqual(mounted, {
      command: "gt",
      login: "https://example.com/gitea",
      repository: "maria/project",
      baseUrl: "https://example.com/gitea",
    });
    yield* cli.api({
      cwd: "/repo",
      context: context("https://example.com/gitea/maria/project.git"),
      repository: "gitea/maria/project",
      path: "repos/gitea/maria/project/pulls?state=open&page=1",
    });
    yield* cli.api({
      cwd: "/repo",
      context: context("git@git.other.test:team/app.git"),
      path: "repos/team/app/pulls/3/merge",
      method: "POST",
      body: { Do: "squash" },
    });
    const byDefault = yield* cli.resolveRepository({ cwd: "/repo", repository: "project" });
    assert.strictEqual(byDefault.baseUrl, "https://git.other.test");
    assert.strictEqual(byDefault.repository, "maria/project");
    const expired = yield* cli
      .api({ cwd: "/repo", repository: "https://expired.test/maria/project", path: "user" })
      .pipe(Effect.flip);
    assert.strictEqual(expired.reason, "authentication");
    assert.deepStrictEqual(hosts, ["https://example.com/gitea", "https://git.other.test"]);
    assert.deepStrictEqual(paths, [
      "repos/maria/project/pulls?state=open&page=1",
      "repos/team/app/pulls/3/merge",
    ]);
  }).pipe(
    Effect.provide(
      withCli({
        run: (input) => {
          if (input.command === "tea") return Effect.succeed(processOutput("[]"));
          if (input.command !== "gt") return undefined;
          if (input.args[0] === "auth")
            return Effect.succeed(
              processOutput(
                encodeJson([
                  gtAccount("https://example.com/gitea"),
                  gtAccount("https://git.other.test"),
                  gtAccount("https://git.other.test", { active: false, user: "other" }),
                  gtAccount("https://expired.test", { credential_available: false }),
                ]),
              ),
            );
          if (input.args[0] === "config") {
            assert.deepStrictEqual(input.args, ["config", "get", "default_host"]);
            return Effect.succeed(processOutput("https://git.other.test\n"));
          }
          hosts.push(input.args[input.args.indexOf("--host") + 1] ?? "");
          paths.push(input.args.at(-1) ?? "");
          return Effect.succeed(processOutput("[]", { stderr: "HTTP/2.0 200 OK\n" }));
        },
      }),
    ),
  );
});

const SECRET = "gto_s3cr3t";

it.effect.each([
  ["a rejected or expired token", 4, "", "", "authentication", undefined],
  [
    "HTTP 401",
    1,
    "HTTP/2.0 401 Unauthorized",
    '{"message":"token expired"}',
    "authentication",
    401,
  ],
  ["HTTP 403", 1, "HTTP/2.0 403 Forbidden", '{"message":"missing scope"}', "forbidden", 403],
  ["HTTP 404", 1, "HTTP/2.0 404 Not Found", '{"message":"not found"}', "not-found", 404],
  ["HTTP 429", 1, "HTTP/2.0 429 Too Many Requests", "", "rate-limit", 429],
  ["HTTP 500", 1, "HTTP/2.0 500 Internal Server Error", "", undefined, 500],
  [
    "a failure without a response",
    1,
    "Error: dial tcp: connection refused",
    "",
    undefined,
    undefined,
  ],
] as const)("reports %s from gt", ([, exitCode, status, body, reason, httpStatus]) =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const error = yield* cli
      .api({ cwd: "/repo", repository: "https://gitea.test/maria/project", path: "user" })
      .pipe(Effect.flip);
    assert.strictEqual(error.command, "gt");
    assert.strictEqual(error.reason, reason);
    assert.strictEqual(error.httpStatus, httpStatus);
    if (httpStatus === 403) assert.include(error.detail, "missing scope");
    assert.notInclude(`${error.detail} ${error.message} ${String(error.cause)}`, SECRET);
  }).pipe(
    Effect.provide(
      withCli({
        run: (input) =>
          gtStatus([gtAccount("https://gitea.test")])(input) ??
          (input.command === "gt"
            ? Effect.succeed(
                processOutput(body, {
                  stderr: `${status}\nSet-Cookie: session=${SECRET}\nError: GITEA_TOKEN ${SECRET} was rejected\n`,
                  exitCode: ChildProcessSpawner.ExitCode(exitCode),
                }),
              )
            : undefined),
      }),
    ),
  ),
);

it.effect("rejects a gt response that is cut short", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const error = yield* provider
      .getDefaultBranch({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo",
            baseUrl: "https://gitea.test",
          },
          remoteName: "origin",
          remoteUrl: "https://gitea.test/maria/project.git",
        },
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.detail, "Forgejo API returned an invalid response.");
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ForgejoCli.layer,
        withCli({
          run: (input) =>
            gtStatus([gtAccount("https://gitea.test")])(input) ??
            (input.command === "gt"
              ? Effect.succeed(
                  processOutput('{"full_name":"maria/pro', { stderr: "HTTP/2.0 200 OK\n" }),
                )
              : undefined),
        }),
      ),
    ),
  ),
);

it.effect.each([
  ["a verified", true, "authenticated"],
  ["an expired", false, "unauthenticated"],
] as const)("shows %s gt login in Settings", ([, verified, status]) =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    if (spec.type !== "managed-cli") return yield* Effect.die("managed discovery missing");
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.executable, "gt");
    assert.strictEqual(result.auth.status, status);
    assert.deepStrictEqual(result.auth.account, Option.some("maria"));
    assert.deepStrictEqual(result.auth.host, Option.some("example.com"));
    if (!verified)
      assert.deepStrictEqual(
        result.auth.detail,
        Option.some("Sign in again with `gt auth login --host https://example.com/gitea`."),
      );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ForgejoCli.layer,
        withCli({
          run: (input) => {
            if (input.command === "git")
              return Effect.succeed(processOutput("https://example.com/gitea/maria/project.git\n"));
            if (input.command !== "gt") return missing(input);
            if (input.args[0] === "--version")
              return Effect.succeed(processOutput("gt version 0.2.0 (2026-10-26)"));
            return Effect.succeed(
              processOutput(
                encodeJson([
                  gtAccount("https://example.com/gitea", {
                    verified: input.args.includes("--verify") ? verified : null,
                    error: verified ? "" : `token ${SECRET} expired`,
                  }),
                ]),
              ),
            );
          },
        }),
      ),
    ),
  ),
);
