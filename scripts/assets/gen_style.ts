// Generates the direction-exploration style images listed in assets-source/style/prompts.json
// through the Higgsfield CLI and records provenance. Usage:
//   bun scripts/assets/gen_style.ts [--spec prompts.json] [--only A-board,B-room] [--out <dir>]
// A spec either crosses `directions` with `subjects`, or lists explicit `jobs` with reference images
// (paths relative to assets-source/style).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

interface Prompts {
  model: string;
  resolution: string;
  shared: string;
  directions?: Record<string, string>;
  subjects?: Record<string, { aspect: string; text: string }>;
  jobs?: { key: string; aspect: string; prompt: string; refs?: string[] }[];
}

interface Record_ {
  key: string;
  file: string;
  model: string;
  aspect: string;
  resolution: string;
  prompt: string;
  refs: string[];
  jobId: string;
  sha256: string;
  generatedAt: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = 'assets-source/style';
const out = flag('--out') ?? join(root, 'explore');
const only = flag('--only')?.split(',');
const spec = JSON.parse(
  readFileSync(join(root, flag('--spec') ?? 'prompts.json'), 'utf8'),
) as Prompts;
mkdirSync(out, { recursive: true });

const jobs: { key: string; prompt: string; aspect: string; refs: string[] }[] = [];
for (const [dir, style] of Object.entries(spec.directions ?? {})) {
  for (const [subject, s] of Object.entries(spec.subjects ?? {})) {
    jobs.push({
      key: `${dir}-${subject}`,
      aspect: s.aspect,
      prompt: `${s.text} ${style} ${spec.shared}`,
      refs: [],
    });
  }
}
for (const j of spec.jobs ?? []) {
  jobs.push({
    key: j.key,
    aspect: j.aspect,
    prompt: `${j.prompt} ${spec.shared}`,
    refs: j.refs ?? [],
  });
}
const selected = only ? jobs.filter((j) => only.includes(j.key)) : jobs;

async function run(cmd: string[]): Promise<string> {
  const [file, ...rest] = cmd;
  const { stdout } = await promisify(execFile)(file ?? '', rest, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function generate(job: (typeof jobs)[number]): Promise<Record_> {
  const raw = await run([
    'higgsfield',
    'generate',
    'create',
    spec.model,
    '--prompt',
    job.prompt,
    '--aspect-ratio',
    job.aspect,
    '--resolution',
    spec.resolution,
    ...job.refs.flatMap((r) => ['--image', join(root, r)]),
    '--wait',
    '--wait-timeout',
    '10m',
    '--json',
  ]);
  const result = (JSON.parse(raw) as { id: string; status: string; result_url: string }[])[0];
  if (!result || result.status !== 'completed') throw new Error(`${job.key}: ${raw}`);
  const bytes = new Uint8Array(await (await fetch(result.result_url)).arrayBuffer());
  const ext = result.result_url.split('?')[0]?.split('.').pop() ?? 'png';
  const file = join(out, `${job.key}.${ext}`);
  writeFileSync(file, bytes);
  return {
    key: job.key,
    file,
    model: spec.model,
    aspect: job.aspect,
    resolution: spec.resolution,
    prompt: job.prompt,
    refs: job.refs,
    jobId: result.id,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    generatedAt: new Date().toISOString(),
  };
}

const provenancePath = join(root, 'provenance.json');
const provenance: Record_[] = existsSync(provenancePath)
  ? (JSON.parse(readFileSync(provenancePath, 'utf8')) as Record_[])
  : [];
const settled = await Promise.allSettled(selected.map(generate));
for (const [i, s] of settled.entries()) {
  if (s.status === 'fulfilled') {
    provenance.push(s.value);
    console.log(`ok   ${s.value.key} ${s.value.file}`);
  } else console.error(`fail ${selected[i]?.key}: ${String(s.reason)}`);
}
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
if (settled.some((s) => s.status === 'rejected')) process.exit(1);
