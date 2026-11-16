import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Bank, Catalog, Node, QuestionFile } from "@exam/schema";
import { compileContent, loadBank, mergeTranslations, migrateV1, restoreV1, validateContent } from "./index.ts";

const [command, ...args] = process.argv.slice(2);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Key order is irrelevant to JSON meaning, so compare with sorted keys. */
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as any)[k])]))
  : v;

switch (command) {
  case "migrate": {
    const [source, bankId, bankDir] = args;
    if (!source || !bankId || !bankDir) fail("usage: migrate <v1.json> <bank-id> <bank-dir>   (writes bank.json and questions/ into <bank-dir>)");
    const { bank, files } = migrateV1(readJson(source), bankId);
    const dir = join(bankDir, "questions");
    mkdirSync(dir, { recursive: true });
    writeJson(join(bankDir, "bank.json"), bank);
    for (const [name, file] of files) writeJson(join(dir, name), file);
    console.log(`${bankId}: ${files.size} files, ${[...files.values()].reduce((n, f) => n + f.questions.length, 0)} questions`);
    break;
  }
  case "verify": {
    const [source, bankDir] = args;
    if (!source || !bankDir) fail("usage: verify <v1.json> <bank-dir>");
    const errors: string[] = [];
    const loaded = loadBank(bankDir, errors);
    if (!loaded || errors.length) fail(errors.join("\n"));
    const original = readJson(source);
    const restored = restoreV1(loaded.bank, loaded.files.values());
    if (!isDeepStrictEqual(sorted(original), sorted(restored))) {
      const keys = Object.keys(original).filter((k) => !isDeepStrictEqual(sorted(original[k]), sorted(restored[k])));
      fail(`MISMATCH in ${bankDir}: ${keys.join(", ")}`);
    }
    console.log(`${bankDir}: identical to the original (${original.questions.length} questions, every field)`);
    break;
  }
  case "validate": {
    const [contentRoot] = args;
    if (!contentRoot) fail("usage: validate <content-root>");
    const { errors, banks, questions } = validateContent(contentRoot);
    if (errors.length) fail(`${errors.join("\n")}\n${errors.length} error(s)`);
    console.log(`OK: ${banks} banks, ${questions} questions`);
    break;
  }
  case "compile": {
    const [contentRoot, outDir] = args;
    if (!contentRoot || !outDir) fail("usage: compile <content-root> <out-dir>");
    try {
      const index = compileContent(contentRoot, outDir);
      console.log(`compiled version ${index.version}: ${index.roots.reduce((n, r) => n + r.banks, 0)} bank links`);
    } catch (e) {
      fail((e as Error).message);
    }
    break;
  }
  case "merge-translations": {
    const [contentRoot] = args;
    if (!contentRoot) fail("usage: merge-translations <content-root>");
    const { errors, warnings, sidecars, written } = mergeTranslations(contentRoot);
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (errors.length) fail([...errors, `${errors.length} error(s); nothing was written`].join("\n"));
    console.log(`merged ${sidecars} sidecar(s), ${written} file(s) changed, ${warnings.length} warning(s)`);
    break;
  }
  case "schema": {
    const [outDir] = args;
    if (!outDir) fail("usage: schema <out-dir>");
    mkdirSync(outDir, { recursive: true });
    for (const [name, schema] of Object.entries({ bank: Bank, questions: QuestionFile, node: Node, catalog: Catalog })) {
      writeJson(join(outDir, `${name}.schema.json`), z.toJSONSchema(schema, { io: "input" }));
    }
    console.log(`schemas written to ${outDir}`);
    break;
  }
  default:
    fail([
      "commands:",
      "  migrate <v1.json> <bank-id> <bank-dir>   convert a 1.0 bank into bank.json + questions/ in <bank-dir>",
      "  verify <v1.json> <bank-dir>              check that <bank-dir> restores the 1.0 file exactly",
      "  validate <content-root>                  check the whole content tree",
      "  compile <content-root> <out-dir>         build the hashed files the apps download",
      "  merge-translations <content-root>        fold <bank-dir>/translations/<locale>/ sidecars into the banks",
      "  schema <out-dir>                         write the JSON Schema files",
    ].join("\n"));
}
