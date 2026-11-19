import { z } from "zod";

export const FORMAT = "exambank/2";

/** A plain string is text in the bank's `language`; an object maps locale -> text. */
const Text = z.string().min(1).refine((s) => s.trim() !== "", "must not be blank");
/** A string, or a set of texts by locale. An empty set or a blank text would crash the screens that show it. */
export const Localized = z.union([Text, z.record(z.string(), Text).refine((set) => Object.keys(set).length > 0, "needs at least one language")]);
export type Localized = z.infer<typeof Localized>;

const LocalizedList = z.record(z.string(), z.array(z.string().min(1)).min(1));

/** Service links for checking keys; the shape is bank-specific. */
const SourceRef = z.looseObject({});

const Accept = z.strictObject({
  /** Option id this answer replaces; absent for `short_text`. */
  for: z.string().optional(),
  accept: LocalizedList,
  ordered: z.boolean().optional(),
});

export const FreeInput = z.strictObject({
  question: Localized.optional(),
  answers: z.array(Accept).min(1),
  reject: LocalizedList.optional(),
  typos: z.enum(["auto", "off"]).optional(),
});
export type FreeInput = z.infer<typeof FreeInput>;

const base = {
  id: z.number().int().positive(),
  topic_id: z.number().int().positive(),
  difficulty_level: z.number().int().positive().optional(),
  exam_block: z.number().int().positive().optional(),
  question: Localized,
  explanation: Localized.optional(),
  retired: z.boolean().optional(),
  source_references: z.array(SourceRef).optional(),
};

const Option = z.strictObject({ id: z.string().min(1), text: Localized });

const choice = {
  ...base,
  options: z.array(Option).min(2),
  correct_answers: z.array(z.string()).min(1),
  free_input: FreeInput.optional(),
};

export const Question = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("single_choice"), ...choice }),
  z.strictObject({ type: z.literal("multiple_choice"), ...choice }),
  z.strictObject({ type: z.literal("short_text"), ...base, answers: z.array(Accept).min(1), reject: LocalizedList.optional(), typos: z.enum(["auto", "off"]).optional() }),
  z.strictObject({
    type: z.literal("numeric"),
    ...base,
    answer: z.strictObject({ value: z.number(), tolerance: z.number().min(0).default(0), unit: Localized.nullable().optional() }),
  }),
  z.strictObject({
    type: z.literal("open"),
    ...base,
    model_answer: Localized,
    rubric: z.array(z.strictObject({ points: z.number().positive(), criterion: Localized })).optional(),
  }),
]);
export type Question = z.infer<typeof Question>;
export type ChoiceQuestion = Extract<Question, { type: "single_choice" | "multiple_choice" }>;

export const QuestionFile = z.strictObject({
  format: z.literal(FORMAT),
  bank: z.string().min(1),
  questions: z.array(Question),
});
export type QuestionFile = z.infer<typeof QuestionFile>;

export const Bank = z.strictObject({
  format: z.literal(FORMAT),
  id: z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/),
  subject: Localized,
  language: z.string().min(2),
  translations: z.record(z.string(), z.enum(["machine", "reviewed"])).optional(),
  created_on: z.string().optional(),
  license: z.string().optional(),
  authors: z.array(z.string()).optional(),
  difficulty_scale: z.array(z.strictObject({ level: z.number().int().positive(), title: Localized })).optional(),
  scoring: z.strictObject({ multiple_choice: z.enum(["exact", "partial"]) }),
  /** Exam profile; shape is bank-specific, known keys are read by the trainer. */
  exam: z.looseObject({}).optional(),
  topics: z.array(z.looseObject({ id: z.number().int().positive(), name: Localized })).min(1),
  sources: z.array(z.unknown()).optional(),
  source_catalog: z.array(z.unknown()).optional(),
  source_indexing: z.unknown().optional(),
  notes: z.unknown().optional(),
  /** Verbatim data from the 1.0 file that has no dedicated field. */
  legacy: z.looseObject({}).optional(),
});
export type Bank = z.infer<typeof Bank>;

/** A folder with `node.json`. Child nodes and banks are the folders inside it; `items` fixes their display order. */
export const Node = z.strictObject({
  kind: z.string().min(1),
  title: Localized,
  order: z.number().optional(),
  /** Folder names (child nodes and banks) in display order; folders not listed follow. */
  items: z.array(z.string()).optional(),
});
export type Node = z.infer<typeof Node>;

export const Catalog = z.strictObject({
  format: z.literal(FORMAT),
  /** `place`: the folder where a student settles (a semester); the app remembers it and opens it on start. */
  kinds: z.record(z.string(), z.strictObject({ title: Localized, place: z.boolean().optional() })),
});
export type Catalog = z.infer<typeof Catalog>;

export { pick } from "./pick.ts";
