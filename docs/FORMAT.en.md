[Қазақша](FORMAT.kk.md) · [Русский](FORMAT.md) · [English](FORMAT.en.md)

# Content format `exambank/2`

The single description of the format and the folder layout. The machine-readable version of the rules is a JSON Schema, which the `schema` command writes (see the end of this document). All examples come from `examples/demo-content`, a neutral set for testing and demonstration.

Check before you submit, from the root of the code repository:

```bash
node packages/content-tools/src/cli.ts validate <content-dir>
```

The command checks the structure, the schemas, the answer keys, and free input: every wording in `accept` must count as correct, and no wrong option and no `reject` entry may. On errors it prints them as a list and exits with code 1. On success it prints `OK: 5 banks, 33 questions` (the numbers will be your own).

## Folder layout

The content root is the folder that holds `catalog.json`. The rest of the tree follows the hierarchy of the curriculum:

```
catalog.json                                  node kinds and the "place" mark
demo/                                         university (node.json)
  science/                                    faculty
    bachelor/                                 degree
      applied-mathematics/                    specialty
        year-1/                               year of study
          semester-1/                         semester
            node.json
            geography/                        bank (bank.json)
              bank.json
              questions/t01.json              questions, by topic
              translations/ru/t01.json        translations in separate files
            natural-sciences/                 subject group (node.json)
              node.json
              physics/bank.json               level bank
              chemistry/bank.json
```

The rules that `validate` checks:

- A folder with `node.json` is a tree node. A folder with `bank.json` is a bank, and it belongs to the node whose folder holds it. A folder cannot be both.
- A folder with neither file but with JSON inside, or with nodes and banks below it, is an error: its contents would be silently ignored.
- A bank cannot sit at the content root, and a bank folder cannot contain nodes or other banks.
- A node with no child nodes and no banks is an error.
- The `schema` and `source` folders at the root, folders whose name starts with a dot (`.github`), and `questions`, `translations`, and `node_modules` at any depth are not part of the tree. JSON in `questions` or `translations` outside a bank folder is an error.
- The depth of the tree and the set of kinds are arbitrary: `validate` only requires that the `kind` of every node is described in `catalog.json`. The example above (seven levels) is defined by data.

The names of node and bank folders become part of the node identifier and of the page address, so `validate` accepts only Latin letters, digits, hyphen, underscore, and dot (the first character is a letter or a digit). Use lowercase Latin letters, digits, and hyphens, as in the bank identifier.

## Identifiers

| What | Identifier | Does it change? |
| --- | --- | --- |
| Node | the folder path from the content root, joined with `/`, for example `demo/science/bachelor/earth-sciences/year-1/semester-1` | Renaming or moving the folder changes it. The choice a student has saved on such a node is reset; progress is not affected |
| Bank | the `id` field in `bank.json`, for example `demo/geography` | Never changes |

A bank identifier does not depend on the folder path. You can move a bank between nodes and rename its folder: the students' progress log refers to the bank `id`, and as long as the `id` stays the same, progress stays in place. Allowed form: `^[a-z0-9-]+(/[a-z0-9-]+)*$`. `validate` rejects a repeated bank `id` and a bank `id` that equals a node `id`.

A bank lives in exactly one folder: the same `id` in two banks is an error. If one subject is taught in two semesters, create two separate banks.

## `catalog.json`

Describes the node kinds. Kind titles appear in lists under the node name.

```json
{
  "format": "exambank/2",
  "kinds": {
    "university": { "title": { "ru": "Университет", "kk": "Университет", "en": "University" } },
    "semester": { "title": { "ru": "Семестр", "kk": "Семестр", "en": "Semester" }, "place": true },
    "subject": { "title": { "ru": "Предмет", "kk": "Пән", "en": "Subject" } }
  }
}
```

`place: true` marks the kind that the app treats as the student's place. This is usually the semester: the student chooses the chain "university, faculty, degree, specialty, year of study, academic year, semester" once. Levels are set by the data: for example, an "academic year" node can sit between the year of study and the semester, so that year of study 1 for 2025 and for 2026 are kept apart. The app remembers the place folder and opens it at launch. If no kind on the path has the mark, the place is the first folder that holds banks. Folders above the place are choice steps; folders below it are subjects. Besides `place`, the only field of a kind is `title`.

To add a new level, for example "department", describe the kind in `catalog.json` and create a folder with a `node.json` of that `kind`.

## Node: `node.json`

```json
{
  "kind": "semester",
  "title": { "en": "Semester 1", "ru": "1 семестр" },
  "order": 10,
  "items": ["geography", "natural-sciences"]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | A kind from `catalog.json` |
| `title` | yes | The name: a string or a set of translations (see below) |
| `order` | no | A number for sorting among sibling nodes that are not in `items`. Lower comes first; ties are broken by folder name. Root nodes sort the same way |
| `items` | no | Folder names of nested nodes and banks in display order. The listed ones come first and may mix nodes and banks; the rest follow them |

Any other field in `node.json` is an error. A name in `items` must name an existing nested folder and must not repeat.

The display order inside a node works out as follows: first the folders from `items`, then the unlisted nodes (by `order`, then by name), then the unlisted banks (by name; banks have no `order` of their own). In the example above the bank `geography` comes before the node `natural-sciences` only because both are named in `items`.

Do not confuse the two `order` fields. In `node.json` it is a number for sorting. In the compiled manifest of a node, `order` is a ready list of the identifiers of nested nodes and banks in display order; `compile` builds it, and nobody writes it by hand.

### Subject group

A node of kind `subject` with banks inside assembles one subject from several level banks. In the demo this is `natural-sciences`:

```json
{
  "kind": "subject",
  "title": { "en": "Natural sciences", "ru": "Естественные науки" },
  "order": 10,
  "items": ["physics", "chemistry"]
}
```

Inside are the folders `physics/` and `chemistry/`, each with its own `bank.json`.

### How the app walks the tree

- A folder with a single entry (one child node or one bank) is skipped: the app keeps going until it reaches a choice of two or more entries. All such steps happen in one move. If the single entry is a bank, that bank opens.
- The app remembers the selected place on the device. If the remembered folder no longer exists in the content, the student chooses again.
- The student changes the choice with the "Change" button and resets it in Settings.

## Text in several languages

Any text field accepts one of two forms:

```json
"question": "Text in the language of the bank"
"question": { "en": "Text", "ru": "Текст" }
```

In a bank, a string means the language from the `language` field. In `node.json`, the app shows a string as is, in any language. You can translate gradually: if the needed language is missing, the app shows the text in the original language. The question number is shared by all translations, so progress does not depend on the language.

The app shows wordings, options, and explanations as Markdown with KaTeX formulas (`$x^2$` inline, `$$…$$` as a separate block). Raw HTML and links are disabled.

## Bank: `bank.json`

```json
{
  "format": "exambank/2",
  "id": "demo/geography",
  "subject": { "en": "Geography", "ru": "География" },
  "language": "en",
  "translations": { "ru": "machine" },
  "license": "CC0-1.0",
  "authors": ["Demo Authors"],
  "difficulty_scale": [
    { "level": 1, "title": { "en": "Recall", "ru": "Знание" } },
    { "level": 2, "title": { "en": "Understanding", "ru": "Понимание" } }
  ],
  "scoring": { "multiple_choice": "exact" },
  "topics": [
    { "id": 1, "name": { "en": "Continents and oceans", "ru": "Континенты и океаны" } },
    { "id": 2, "name": { "en": "Rivers and mountains", "ru": "Реки и горы" } }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Always `exambank/2` |
| `id` | yes | The bank identifier (see above) |
| `subject` | yes | The subject name |
| `language` | yes | The original language: the string fields are written in it |
| `translations` | no | Translation quality by language: `machine` or `reviewed`. New languages get `machine` from `merge-translations`; you set `reviewed` by hand |
| `difficulty_scale` | no | The scale for the `difficulty_level` of questions. It can have any number of levels, or there can be no scale |
| `scoring.multiple_choice` | yes | `exact`: only the complete set counts. `partial`: partial credit |
| `topics` | yes | At least one topic. The topic `id` is used in questions as `topic_id` |
| `created_on`, `license`, `authors` | no | Information about the bank |
| `exam` | no | A free-form object with an exam profile. The app reads two fields: `duration_minutes` and `test_question_count`. When both are positive whole numbers, the mock exam setup shows a button that sets the same length and number of questions. Also read is `official_levels`: a list of `{level, per_test}` (a difficulty level and how many questions of that level one test has; a record with `bank_share` instead of `per_test` is not read). When it is set, the "like the exam" mock exam takes that many questions of each level. Other fields are not read |
| `sources`, `source_catalog`, `source_indexing`, `notes`, `legacy` | no | Service information about where the bank came from |

Topics allow extra fields. Otherwise the schema is strict: a typo in a field name causes an error.

## Question files

Questions live in `<bank>/questions/*.json`, one file per topic. The file name is arbitrary (`t01.json` is customary); the topic is set by the question's `topic_id`. A file comfortably holds 15 to 50 questions. For a new topic, add an entry to `topics` and a new file.

```json
{
  "format": "exambank/2",
  "bank": "demo/geography",
  "questions": [ … ]
}
```

The `bank` field must equal the bank `id`.

### Common question fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A positive integer, unique within the bank. It never changes and is never reused: progress refers to it |
| `topic_id` | yes | The topic `id` from `bank.json` |
| `type` | yes | `single_choice`, `multiple_choice`, `short_text`, `numeric`, `open` |
| `question` | yes | The wording |
| `difficulty_level` | no | Subject difficulty on the bank's scale. It is unrelated to whether the student picks an answer or types it |
| `exam_block` | no | A label for an exam block. A session in the core can select by block; the bank screen shows no such filter |
| `explanation` | no | An explanation shown after the answer |
| `source_references` | no | Service references to the source, for checking the key |
| `retired` | no | `true` on a question withdrawn from display. A question must not be deleted |

There must be no other fields.

### Choice questions: `single_choice` and `multiple_choice`

```json
{
  "id": 1,
  "topic_id": 1,
  "difficulty_level": 1,
  "type": "single_choice",
  "question": { "en": "The largest ocean on Earth is the...", "ru": "Самый большой океан на Земле называется..." },
  "options": [
    { "id": "A", "text": { "en": "Atlantic Ocean", "ru": "Атлантический океан" } },
    { "id": "B", "text": { "en": "Pacific Ocean", "ru": "Тихий океан" } }
  ],
  "correct_answers": ["B"],
  "free_input": {
    "answers": [
      { "for": "B", "accept": { "en": ["Pacific", "Pacific Ocean"], "ru": ["Тихий", "Тихий океан"] } }
    ]
  },
  "explanation": "The Pacific Ocean covers about a third of the planet's surface."
}
```

(In the demo this question has five options; it is shortened here.) The rules: at least two options; option `id`s are unique; a `single_choice` question has exactly one option in `correct_answers`, a `multiple_choice` question has one or more; every correct answer is among the options. The app shuffles the order of the options itself.

### Free input: the `free_input` block

The block turns the same question into a task for the "Typing" mode: the options are hidden and the student types the answer. The block is optional. Without it, in typing mode the question is self-checked (the student sees the correct answer and marks whether they knew it) or skipped, as set in Settings.

| Field | Meaning |
| --- | --- |
| `answers` | One entry per correct option: `for` (the letter of the option) and `accept` (the wordings that count, by language). Together they must cover exactly `correct_answers` |
| `question` | A different wording for typing mode. It is needed when the original relies on the options or is ambiguous without them (in the demo the question about the continents of the Southern Hemisphere is built this way; example below) |
| `reject` | Close but wrong answers that are not among the options |
| `typos` | `"off"` disallows typos in this question; the default is `"auto"` |
| `answers[].ordered` | `true` if the order of words in the answer matters |

Add the block only when the answer can be named without a hint: a term, a name, a number, a short phrase. Leave a long statement without the block.

What to put in `accept`: the base form (nominative case, singular), common synonyms and abbreviations, and variants of scope (`Pacific` and `Pacific Ocean`).

What not to put there: capitalization, spaces, punctuation, `ё`, case endings, words from the question itself, typos. The check handles these itself. Typos are forgiven in words longer than four characters: one error up to eight characters, two in longer words. Numbers and short words are checked strictly. The letters `ә ғ қ ң ө ұ ү һ і` can be replaced with the nearest plain ones (`а г к н о у у х и`): that is how they come out when typing on a Russian keyboard layout, and the answer counts.

The check does not guess synonyms. Only what is listed counts, and an answer that resembles another term in the bank or a wrong option is rejected. The wordings of all languages are checked as one list: a synonym written for `en` also counts when the interface is Russian. Keep the synonym sets parallel across languages.

A question with several answers gives as many input fields as there are entries in `answers`. The order of the answers does not matter:

```json
"free_input": {
  "question": { "en": "Name the two continents that lie entirely in the Southern Hemisphere.", "ru": "Назовите два материка, которые целиком расположены в Южном полушарии." },
  "answers": [
    { "for": "A", "accept": { "en": ["Antarctica"], "ru": ["Антарктида"] } },
    { "for": "B", "accept": { "en": ["Australia"], "ru": ["Австралия"] } }
  ]
}
```

### Typing only: `short_text`

A question without options. The fields `answers`, `reject`, and `typos` sit directly in the question, and `for` is not needed.

```json
{
  "id": 5,
  "topic_id": 1,
  "type": "short_text",
  "question": "What is the result of a multiplication called?",
  "answers": [ { "accept": { "en": ["product", "the product"] } } ],
  "reject": { "en": ["factor", "sum"] },
  "typos": "off",
  "explanation": "In 6 x 7 = 42 the numbers 6 and 7 are factors and 42 is the product."
}
```

### Number: `numeric`

```json
{
  "id": 3,
  "topic_id": 1,
  "type": "numeric",
  "question": "What is 15% of 200?",
  "answer": { "value": 30, "tolerance": 0, "unit": null }
}
```

`tolerance` sets the allowed deviation in both directions (0 by default). `unit` is optional: a string, a set of translations, or `null`. A comma and a point in a decimal fraction are equivalent. A `numeric` question exists only in typing mode.

### Open answer: `open`

The student checks their own answer against a model answer. The only answer mode is self-check.

```json
{
  "id": 7,
  "topic_id": 1,
  "type": "open",
  "question": "Explain why the sum of two odd numbers is always even.",
  "model_answer": "Write the odd numbers as 2a + 1 and 2b + 1. Their sum is 2a + 2b + 2 = 2(a + b + 1), which has the factor 2, so it is even.",
  "rubric": [
    { "points": 1, "criterion": "Writes odd numbers in the form 2k + 1" },
    { "points": 1, "criterion": "Shows that the sum has the factor 2" }
  ]
}
```

`rubric` is optional; `points` is a positive number.

## Translations as separate files

The translator does not edit the bank's source files. They put translation files (sidecars) next to them, and a command merges them into the bank:

```
<bank>/translations/<locale>/bank.json      subject and names of the difficulty levels
<bank>/translations/<locale>/<topic>.json   one topic: name, questions, options
```

An example of a topic (`geography/translations/ru/t01.json`):

```json
{
  "bank": "demo/geography",
  "locale": "ru",
  "topic_id": 1,
  "topic_name": "Континенты и океаны",
  "questions": {
    "1": {
      "question": "Самый большой океан на Земле называется...",
      "options": { "A": "Атлантический океан", "B": "Тихий океан" },
      "free_input": { "accept": { "B": ["Тихий", "Тихий океан"] } }
    },
    "5": { "question": "Сколько материков в распространённой модели из семи материков?" }
  }
}
```

(In the demo, question 1 has five options; it is shortened here.) The bank sidecar: `{ "bank": "demo/geography", "locale": "ru", "subject": "География", "difficulty_scale": { "1": "Знание", "2": "Понимание" } }`.

What sidecars translate: the subject name, the level names, the topic names, the question text, the options, and, for choice questions, also `free_input` (`question`, `accept` by option letters, `reject`). For questions without options, the sidecar holds only `question`. Explanations, `short_text.answers`, `model_answer`, and `rubric` are not translated by sidecars: add a set of translations directly in the question.

The merge:

```bash
node packages/content-tools/src/cli.ts merge-translations <content-dir>
```

The command turns strings into sets like `{ "en": "original", "ru": "translation" }`, and in sets that already exist it sets or replaces only the language key. The original does not change. In `bank.json` the new language gets `"translations": { "ru": "machine" }` unless `reviewed` is already there. Running it again changes nothing.

The command first checks all sidecars and only then writes anything. Errors (exit code 1, nothing written): a question that is not from this bank or not from this topic, a missing or extra option, an empty string, a `bank` that does not match the bank `id`, a `locale` that does not match the sidecar's folder, a locale equal to the bank's `language`, a path not of the form `translations/<locale>/<file>.json`. Warnings (code 0, the rest is merged): a question of the topic has no translation, a `free_input` has no translation of `accept`. If a question has no source `free_input.question`, the translated one is not added: it would hide the original.

## Banks from format 1.0

A version 1.0 file (one JSON per bank) is converted by the `migrate` command, which writes `bank.json` and `questions/` into the given bank folder:

```bash
node packages/content-tools/src/cli.ts migrate <v1.json> <bank-id> <bank-dir>
```

Afterwards, put the bank folder into the tree under a suitable node. What changed compared with 1.0: one file is split into `bank.json` and topic files; the `instruction` field is removed from questions (the app shows the caption "Choose the one correct option" itself); counters (`question_count` and the like) are not stored but computed; texts can be a string or a set of translations; `free_input`, `explanation`, `retired`, and the types `short_text`, `numeric`, and `open` are added. The `verify <v1.json> <bank-dir>` command assembles the bank back into the 1.0 format and compares it with the original file. After substantive edits to the bank, a mismatch is expected.

## What the app receives

The `compile <content-dir> <out-dir>` command checks the content (on errors it writes nothing) and builds files whose names contain a hash of the content: the first 16 characters of SHA-256.

```
index.json              version, node kinds, root nodes (the only file without a hash in its name)
nodes/<hash>.json       node manifest: id, kind, title, children, banks, order
banks/<hash>.json       the bank and all its questions
```

The output folder is erased before the build, so it must not lie inside the content folder, contain it, or be the same as it. It erases only an empty folder or a previous build (nothing inside but `nodes`, `banks`, `index.json`); with any other folder the command stops and deletes nothing. The app rereads `index.json`, loads manifests and banks by hash, verifies the hash of every file, and caches it forever. Retired questions (`retired`) stay in the bank file but are not counted. Their ids are listed in ascending order in the bank entry of the node manifest (field `retired`, absent for a bank with no retired questions), so the catalog does not count them as mastered.

JSON Schema for an editor or a generator: `node packages/content-tools/src/cli.ts schema <out-dir>` writes `bank.schema.json`, `questions.schema.json`, `node.schema.json`, and `catalog.schema.json`.
