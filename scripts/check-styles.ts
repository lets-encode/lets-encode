// Reports where a component's <style> block departs from the shared styles:
// a hex colour other than white, a font size in rem, a border radius outside
// the radius steps, or a rule that sets a property which src/routes/ui.css
// sets for the same class name. It also lists the component rules that only
// place a shared class, since a class of that name on an unrelated element
// takes the shared look. It prints its findings and always exits with 0.
//
//   npm run check:styles

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const uiCss = join(root, "src/routes/ui.css");

/** Radius values a component may write: the steps of theme.css (--radius-*),
    the small radii of bars and marks, and a circle. */
const RADII = new Set([
  "0",
  "1px",
  "2px",
  "3px",
  "4px",
  "6px",
  "8px",
  "10px",
  "12px",
  "14px",
  "999px",
  "50%",
]);

type Rule = { selector: string; body: string; offset: number };

/** The rules of a stylesheet, with nested at-rule blocks flattened and
    comments blanked so offsets stay those of the source. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const found: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lead = m[1].length - m[1].trimStart().length;
    found.push({
      selector: m[1].trim().replace(/\s+/g, " "),
      body: m[2],
      offset: m.index + lead,
    });
  }
  return found;
}

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith(".svelte") ? [path] : [];
  });
}

const lineOf = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length;

/** A selector that is one class, with or without pseudo-classes. */
const lone = (selector: string) =>
  /^\s*\.([a-z][\w-]*)(?::[\w-]+)*\s*$/.exec(selector)?.[1];

const properties = (body: string) =>
  body
    .split(";")
    .map((declaration) => declaration.split(":")[0].trim())
    .filter(Boolean);

/** Properties that place an element; a component may set them on a shared
    class. */
const PLACES =
  /^(margin|flex|order|align-self|justify-self|grid|position|inset|top|right|bottom|left|z-index|width|height|min-|max-|display|overflow|container)/;

// The properties ui.css sets for each class that has a rule of its own.
const shared = new Map<string, Set<string>>();
for (const rule of rules(readFileSync(uiCss, "utf8"))) {
  for (const selector of rule.selector.split(/,(?![^(]*\))/)) {
    const name = lone(selector);
    if (!name) continue;
    const set = shared.get(name) ?? new Set<string>();
    for (const property of properties(rule.body)) set.add(property);
    shared.set(name, set);
  }
}

const findings = new Map<string, string[]>([
  ["Hex colour", []],
  ["Font size in rem", []],
  ["Radius outside the steps", []],
  ["Property of a shared class set again", []],
  ["Shared class placed by a component", []],
]);
const report = (check: string, file: string, line: number, text: string) =>
  findings.get(check)!.push(`${relative(root, file)}:${line}  ${text}`);

for (const file of svelteFiles(join(root, "src"))) {
  const source = readFileSync(file, "utf8");
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source);
  if (!style) continue;
  const start = style.index + style[0].indexOf(">") + 1;
  for (const rule of rules(style[1])) {
    const line = lineOf(source, start + rule.offset);
    for (const declaration of rule.body.split(";")) {
      const [property, ...rest] = declaration.split(":");
      const value = rest.join(":").trim();
      if (!value) continue;
      // White on a solid fill is written #fff, in ui.css too.
      const hex = value
        .match(/#[0-9a-f]{3,8}\b/gi)
        ?.filter((colour) => !/^#f{3}(f{3})?$/i.test(colour));
      if (hex?.length)
        report("Hex colour", file, line, `${rule.selector} { ${hex} }`);
      if (/^font(-size)?$/.test(property.trim()) && /[\d.]rem\b/.test(value))
        report("Font size in rem", file, line, `${rule.selector} { ${value} }`);
      if (property.trim() === "border-radius") {
        const off = value
          .split(/\s+/)
          .filter((part) => !part.startsWith("var(") && !RADII.has(part));
        if (off.length)
          report(
            "Radius outside the steps",
            file,
            line,
            `${rule.selector} { ${value} }`,
          );
      }
    }
    for (const selector of rule.selector.split(/,(?![^(]*\))/)) {
      const name = lone(selector);
      const again = properties(rule.body).filter(
        (property) =>
          !PLACES.test(property) && name && shared.get(name)?.has(property),
      );
      if (again.length)
        report(
          "Property of a shared class set again",
          file,
          line,
          `.${name} { ${again.join(", ")} }`,
        );
      else if (name && shared.has(name))
        report("Shared class placed by a component", file, line, `.${name}`);
    }
  }
}

let total = 0;
for (const [check, lines] of findings) {
  total += lines.length;
  console.log(`\n${check}: ${lines.length}`);
  for (const line of lines.sort()) console.log(`  ${line}`);
}
console.log(`\n${total} findings.`);
