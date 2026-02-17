import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type Mode = "smoke" | "full";

type Category =
  | "edit_existing"
  | "create_new"
  | "run_project"
  | "browser_interaction"
  | "debug"
  | "memory_session"
  | "workspace_management"
  | "code_generation_refactoring"
  | "documentation_understanding"
  | "debug_execution_loop"
  | "edge_cases_stress";

type Severity = "critical" | "high" | "normal";

interface FixtureWrite {
  type?: "file";
  path: string;
  content: string;
}

interface FixtureDir {
  type: "dir";
  path: string;
}

type FixtureEntry = FixtureWrite | FixtureDir;

type Postcondition =
  | { kind: "file_exists"; path: string }
  | { kind: "file_not_exists"; path: string }
  | { kind: "dir_exists"; path: string }
  | { kind: "dir_not_exists"; path: string }
  | { kind: "file_contains"; path: string; needle: string; caseSensitive?: boolean }
  | { kind: "file_regex"; path: string; pattern: string; flags?: string }
  | { kind: "file_not_regex"; path: string; pattern: string; flags?: string }
  | { kind: "log_contains"; needle: string; caseSensitive?: boolean }
  | { kind: "plan_success" };

interface TaskCase {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  smoke?: boolean;
  approvalMode?: "ask" | "auto" | "unrestricted";
  prompt: string;
  fixtures?: FixtureEntry[];
  postconditions: Postcondition[];
  timeoutMs?: number;
}

interface PlanResponse {
  runId: string;
}

interface RunStatusResponse {
  runId: string;
  isFinished: boolean;
  logs: string[];
  plan: {
    task: string;
    steps: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" | "failed"; notes?: string }>;
  };
}

interface ConditionResult {
  ok: boolean;
  detail: string;
}

interface TaskResult {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  passed: boolean;
  durationMs: number;
  runId?: string;
  failures: string[];
}

interface Args {
  mode: Mode;
  reportOnly: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const qaDir = path.join(root, "qa");
  const resultsDir = path.join(qaDir, "results");
  const taskBankPath = path.join(qaDir, "task-bank.jsonl");
  const resultsJsonPath = path.join(resultsDir, "latest.json");
  const resultsMdPath = path.join(resultsDir, "latest.md");

  if (args.reportOnly) {
    const raw = await readFile(resultsJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const markdown = renderMarkdownSummary(parsed);
    await writeFile(resultsMdPath, markdown, "utf8");
    process.stdout.write(`Report written: ${toRelative(root, resultsMdPath)}\n`);
    return;
  }

  const serviceUrl = process.env.AGENT_SERVICE_URL ?? "http://localhost:4000";
  const workspaceRoot = path.resolve(root, process.env.QA_WORKSPACE_ROOT ?? "agent_do_stuff_here");
  const tasks = await loadTaskBank(taskBankPath);
  const selected = selectTasks(tasks, args.mode);
  if (selected.length === 0) {
    throw new Error(`No tasks selected for mode=${args.mode}.`);
  }

  await mkdir(resultsDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const results: TaskResult[] = [];

  process.stdout.write(`Running ${selected.length} ${args.mode} tasks against ${serviceUrl}\n`);
  process.stdout.write(`Workspace fixture root: ${workspaceRoot}\n`);

  for (const task of selected) {
    const taskStarted = Date.now();
    const failures: string[] = [];
    let runId = "";
    const taskWorkspaceRoot = path.join(workspaceRoot, sanitizeTaskId(task.id));

    try {
      await resetTaskWorkspace(taskWorkspaceRoot);
      await applyFixtures(taskWorkspaceRoot, task.fixtures ?? []);
      const plan = await postJson<PlanResponse>(`${serviceUrl}/plan`, {
        task: task.prompt,
        workspaceRoot: taskWorkspaceRoot,
        approvalMode: task.approvalMode ?? "unrestricted",
        sessionId: "qa-regression"
      });
      runId = plan.runId;
      const timeoutMs = task.timeoutMs ?? 120_000;
      const run = await waitForRun(`${serviceUrl}/runs/${encodeURIComponent(runId)}`, timeoutMs);

      const checks = await evaluatePostconditions(taskWorkspaceRoot, run, task.postconditions);
      for (const c of checks) {
        if (!c.ok) {
          failures.push(c.detail);
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    const durationMs = Date.now() - taskStarted;
    const passed = failures.length === 0;
    const result: TaskResult = {
      id: task.id,
      title: task.title,
      category: task.category,
      severity: task.severity,
      passed,
      durationMs,
      runId: runId || undefined,
      failures
    };
    results.push(result);
    const marker = passed ? "PASS" : "FAIL";
    process.stdout.write(`[${marker}] ${task.id} (${task.category}) ${durationMs}ms\n`);
    if (!passed) {
      for (const failure of failures) {
        process.stdout.write(`  - ${failure}\n`);
      }
    }
  }

  const summary = buildSummary(args.mode, startedAt, serviceUrl, workspaceRoot, results);
  await writeFile(resultsJsonPath, JSON.stringify(summary, null, 2), "utf8");
  await writeFile(resultsMdPath, renderMarkdownSummary(summary), "utf8");

  process.stdout.write(`\nSummary: ${summary.passCount}/${summary.total} passed\n`);
  process.stdout.write(`JSON: ${toRelative(root, resultsJsonPath)}\n`);
  process.stdout.write(`MD: ${toRelative(root, resultsMdPath)}\n`);
  if (summary.failCount > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): Args {
  let mode: Mode = "smoke";
  let reportOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = argv[i + 1];
      if (value === "smoke" || value === "full") {
        mode = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--report-only") {
      reportOnly = true;
    }
  }
  return { mode, reportOnly };
}

async function loadTaskBank(taskBankPath: string): Promise<TaskCase[]> {
  const raw = await readFile(taskBankPath, "utf8");
  const tasks: TaskCase[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as TaskCase;
    tasks.push(parsed);
  }
  return tasks;
}

function selectTasks(tasks: TaskCase[], mode: Mode): TaskCase[] {
  if (mode === "full") {
    return tasks;
  }
  const smoke = tasks.filter((task) => task.smoke ?? task.severity !== "normal");
  return smoke.length > 0 ? smoke : tasks.slice(0, Math.min(12, tasks.length));
}

async function applyFixtures(workspaceRoot: string, fixtures: FixtureEntry[]): Promise<void> {
  for (const fixture of fixtures) {
    const fixturePath = safeWorkspacePath(workspaceRoot, fixture.path);
    if (fixture.type === "dir") {
      await mkdir(fixturePath, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, fixture.content, "utf8");
  }
}

async function resetTaskWorkspace(taskWorkspaceRoot: string): Promise<void> {
  await rm(taskWorkspaceRoot, { recursive: true, force: true });
  await mkdir(taskWorkspaceRoot, { recursive: true });
}

async function evaluatePostconditions(
  workspaceRoot: string,
  run: RunStatusResponse,
  postconditions: Postcondition[]
): Promise<ConditionResult[]> {
  const results: ConditionResult[] = [];
  for (const condition of postconditions) {
    if (condition.kind === "plan_success") {
      const failed = run.plan.steps.filter((step) => step.status === "failed");
      const allDone = run.isFinished && failed.length === 0;
      results.push({
        ok: allDone,
        detail: allDone ? "plan_success ok" : `plan_success failed (${failed.map((s) => s.id).join(", ") || "run not finished"})`
      });
      continue;
    }

    if (condition.kind === "file_exists") {
      const filePath = safeWorkspacePath(workspaceRoot, condition.path);
      const ok = await existsFile(filePath);
      results.push({
        ok,
        detail: ok ? `file_exists ok: ${condition.path}` : `Expected file to exist: ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "file_not_exists") {
      const filePath = safeWorkspacePath(workspaceRoot, condition.path);
      const ok = !(await existsPath(filePath));
      results.push({
        ok,
        detail: ok ? `file_not_exists ok: ${condition.path}` : `Expected file to be removed: ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "dir_exists") {
      const dirPath = safeWorkspacePath(workspaceRoot, condition.path);
      const ok = await existsDirectory(dirPath);
      results.push({
        ok,
        detail: ok ? `dir_exists ok: ${condition.path}` : `Expected directory to exist: ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "dir_not_exists") {
      const dirPath = safeWorkspacePath(workspaceRoot, condition.path);
      const ok = !(await existsPath(dirPath));
      results.push({
        ok,
        detail: ok ? `dir_not_exists ok: ${condition.path}` : `Expected directory to be removed: ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "file_contains") {
      const filePath = safeWorkspacePath(workspaceRoot, condition.path);
      const ok = await fileContains(filePath, condition.needle, condition.caseSensitive ?? false);
      results.push({
        ok,
        detail: ok ? `file_contains ok: ${condition.path}` : `Expected "${condition.needle}" in ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "file_regex") {
      const filePath = safeWorkspacePath(workspaceRoot, condition.path);
      const content = await readFile(filePath, "utf8");
      const regex = new RegExp(condition.pattern, condition.flags ?? "");
      const ok = regex.test(content);
      results.push({
        ok,
        detail: ok ? `file_regex ok: ${condition.path}` : `Regex /${condition.pattern}/${condition.flags ?? ""} failed on ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "file_not_regex") {
      const filePath = safeWorkspacePath(workspaceRoot, condition.path);
      const content = await readFile(filePath, "utf8");
      const regex = new RegExp(condition.pattern, condition.flags ?? "");
      const ok = !regex.test(content);
      results.push({
        ok,
        detail: ok
          ? `file_not_regex ok: ${condition.path}`
          : `Regex /${condition.pattern}/${condition.flags ?? ""} unexpectedly matched ${condition.path}`
      });
      continue;
    }

    if (condition.kind === "log_contains") {
      const haystack = run.logs.join("\n");
      const ok = (condition.caseSensitive ?? false)
        ? haystack.includes(condition.needle)
        : haystack.toLowerCase().includes(condition.needle.toLowerCase());
      results.push({
        ok,
        detail: ok ? "log_contains ok" : `Expected logs to contain: ${condition.needle}`
      });
      continue;
    }
  }
  return results;
}

async function waitForRun(runUrl: string, timeoutMs: number): Promise<RunStatusResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await getJson<RunStatusResponse>(runUrl);
    if (run.isFinished) {
      return run;
    }
    await sleep(1000);
  }
  throw new Error(`Run did not finish in ${timeoutMs}ms`);
}

function buildSummary(
  mode: Mode,
  startedAt: string,
  serviceUrl: string,
  workspaceRoot: string,
  results: TaskResult[]
): Record<string, unknown> {
  const total = results.length;
  const passCount = results.filter((r) => r.passed).length;
  const failCount = total - passCount;
  const byCategory: Record<string, { total: number; pass: number; fail: number; passRate: number }> = {};
  for (const r of results) {
    const slot = byCategory[r.category] ?? { total: 0, pass: 0, fail: 0, passRate: 0 };
    slot.total += 1;
    if (r.passed) {
      slot.pass += 1;
    } else {
      slot.fail += 1;
    }
    slot.passRate = slot.total === 0 ? 0 : Math.round((slot.pass / slot.total) * 10000) / 100;
    byCategory[r.category] = slot;
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    serviceUrl,
    workspaceRoot,
    total,
    passCount,
    failCount,
    passRate: total === 0 ? 0 : Math.round((passCount / total) * 10000) / 100,
    byCategory,
    results
  };
}

function renderMarkdownSummary(summary: Record<string, unknown>): string {
  const total = Number(summary.total ?? 0);
  const passCount = Number(summary.passCount ?? 0);
  const failCount = Number(summary.failCount ?? 0);
  const passRate = Number(summary.passRate ?? 0);
  const mode = String(summary.mode ?? "unknown");
  const startedAt = String(summary.startedAt ?? "");
  const finishedAt = String(summary.finishedAt ?? "");
  const serviceUrl = String(summary.serviceUrl ?? "");
  const workspaceRoot = String(summary.workspaceRoot ?? "");
  const byCategory = (summary.byCategory as Record<string, { total: number; pass: number; fail: number; passRate: number }>) ?? {};
  const results = (summary.results as TaskResult[]) ?? [];

  const lines: string[] = [];
  lines.push("# Regression Summary");
  lines.push("");
  lines.push(`- Mode: \`${mode}\``);
  lines.push(`- Started: \`${startedAt}\``);
  lines.push(`- Finished: \`${finishedAt}\``);
  lines.push(`- Service: \`${serviceUrl}\``);
  lines.push(`- Workspace: \`${workspaceRoot}\``);
  lines.push(`- Result: **${passCount}/${total} passed** (${passRate}%), ${failCount} failed`);
  lines.push("");
  lines.push("## Category Metrics");
  lines.push("");
  lines.push("| Category | Total | Pass | Fail | Pass Rate |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [category, metric] of Object.entries(byCategory)) {
    lines.push(`| ${category} | ${metric.total} | ${metric.pass} | ${metric.fail} | ${metric.passRate}% |`);
  }
  lines.push("");
  lines.push("## Failed Tasks");
  lines.push("");
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    lines.push("- None");
  } else {
    for (const task of failed) {
      lines.push(`- \`${task.id}\` ${task.title}`);
      for (const reason of task.failures) {
        lines.push(`  - ${reason}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${url}: ${body}`);
  }
  return (await response.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${url}: ${body}`);
  }
  return (await response.json()) as T;
}

function safeWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const candidate = path.resolve(workspaceRoot, normalized);
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (!candidate.startsWith(rootWithSep) && candidate !== workspaceRoot) {
    throw new Error(`Unsafe fixture/check path: ${relativePath}`);
  }
  return candidate;
}

async function existsFile(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function existsDirectory(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function existsPath(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileContains(filePath: string, needle: string, caseSensitive: boolean): Promise<boolean> {
  const content = await readFile(filePath, "utf8");
  if (caseSensitive) {
    return content.includes(needle);
  }
  return content.toLowerCase().includes(needle.toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replace(/\\/g, "/");
}

function sanitizeTaskId(taskId: string): string {
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return safe || "task";
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
