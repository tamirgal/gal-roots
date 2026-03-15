<%*
// ── Auto-increment cr_id ──────────────────────────────────────────────────
let maxId = 0;
for (const file of app.vault.getMarkdownFiles()) {
  const cr_id = app.metadataCache.getFileCache(file)?.frontmatter?.cr_id;
  if (typeof cr_id === "string") {
    const n = parseInt(cr_id.replace("ind", ""));
    if (!isNaN(n) && n > maxId) maxId = n;
  }
}
const nextId = "ind" + String(maxId + 1).padStart(5, "0");

// ── Prompts ───────────────────────────────────────────────────────────────
const name   = await tp.system.prompt("Full name (e.g. Tamir Gal)");
if (!name) return;

const born   = await tp.system.prompt("Birth date — YYYY-MM-DD or YYYY (blank = unknown)", "");
const sex    = await tp.system.suggester(["male", "female", "(unknown — omit)"], ["male", "female", null]);

const father = await tp.system.prompt("Father's full name (blank = unknown)", "");
const mother = await tp.system.prompt("Mother's full name (blank = unknown)", "");

const hasPortrait = await tp.system.suggester(["No", "Yes"], [false, true], false, "Will you add a portrait?");
const portrait    = hasPortrait
  ? await tp.system.prompt("Portrait filename (e.g. Tamir-Gal.jpg)")
  : null;

// ── Derived fields ────────────────────────────────────────────────────────
const filename = name.replace(/\s+/g, "-");
await tp.file.rename(filename);

// research_level: 2 = bio + (date or portrait), 1 = date or portrait only, 0 = name only
const researchLevel = (born || portrait) ? (born && portrait ? 2 : 1) : 0;

const fatherLink = father ? `"[[People/${father.replace(/\s+/g, "-")}]]"` : '""';
const motherLink = mother ? `"[[People/${mother.replace(/\s+/g, "-")}]]"` : '""';
const mediaBlock  = portrait ? `\nmedia:\n  - "[[attachments/pictures/${portrait}]]"` : "";
const sexLine     = sex ? `\nsex: ${sex}` : "";
const bornLine    = born ? `\nborn: "${born}"` : "";
const fatherBlock = father ? `\nfather: ${fatherLink}\nfather_id: ` : "";
const motherBlock = mother ? `\nmother: ${motherLink}\nmother_id: ` : "";
-%>
---
cr_id: <% nextId %>
name: <% name %><% bornLine %><% sexLine %><% fatherBlock %><% motherBlock %><% mediaBlock %>
research_level: <% researchLevel %>
---
