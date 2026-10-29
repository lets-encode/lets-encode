<!--
  The instruments step of an 'omr-instruments' layout task, in two parts.
  Between the fields and each strip, a column shows the braces, brackets and
  groups the names make.
  First the instruments of the piece's first system: the system as a strip of
  its opening (the printed names, clefs, key and meter up to the end of its
  first measure) with, beside each single staff, the instrument and the parts
  the staff carries ("I", "1.2.3"), and beside each grand staff the
  instrument; below, the instruments with their full and short names, and the
  groups of instruments. Once the volunteer has fixed them, the other
  systems: each single staff and grand staff picks an instrument of the list
  and which of its parts the staff carries. An instrument added there is
  marked with its page for the reviewer. With the first system's instruments
  confirmed, the editor sees a summary of the instruments and the groups
  first. A viewer who cannot edit (the reviewer) sees every system with the
  names as text instead of fields. With `whole`, every page is shown whole,
  with the same fields beside its staves.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import type { PageModel } from "$lib/mei-facsimile.ts";
  import type {
    LayoutGroup,
    LayoutInstrument,
    LayoutInstruments,
  } from "$lib/omr-layout.ts";
  import {
    doubleNamings,
    mergeInstrument,
    type DoubleNaming,
    firstNamingSystem,
    inSystem,
    namingUnits,
    partsLabel,
    unitName,
    type NamingUnit,
  } from "$lib/instrument-naming.ts";

  let {
    pages,
    urls,
    named,
    canEdit,
    whole = false,
    ondefine,
    onassign,
    onabbr,
    oninstrument,
    ongroups,
    onfix,
    onmerge,
    fixBlock,
  }: {
    /** The pages with their corrected boxes; staff boxes carry their named staff. */
    pages: PageModel[];
    /** Per page, its image URL ('' when it could not be loaded). */
    urls: string[];
    named: LayoutInstruments;
    canEdit: boolean;
    /** Every page whole beside the fields, instead of each system's opening. */
    whole?: boolean;
    /** Name a unit by instrument name and parts ('' clears it); `added` is the 1-based page of an instrument added after the first system. */
    ondefine: (
      unit: NamingUnit,
      name: string,
      parts: string,
      added?: number,
    ) => void;
    /** Show an instrument of the list, with the parts (indices) for a one-staff unit. */
    onassign: (unit: NamingUnit, instrument: string, parts: number[]) => void;
    /** Set an instrument's short name. */
    onabbr: (instrument: string, abbr: string) => void;
    /** Change an instrument's other fields: whether its parts are instruments, and their short names. */
    oninstrument: (
      instrument: string,
      change: Pick<Partial<LayoutInstrument>, "partsAreInstruments" | "parts">,
    ) => void;
    ongroups: (groups: LayoutGroup[]) => void;
    /** Open the other systems (true) or the first system (false). */
    onfix: (fixed: boolean) => void;
    /** Make an instrument named a second time a part of the one it looks like. */
    onmerge: (double: DoubleNaming) => void;
    /** Why the other systems cannot be opened yet; null when they can. */
    fixBlock: string | null;
  } = $props();

  // Instruments that look like another one named a second time, by id.
  const doubles = $derived(doubleNamings(named));
  const doubleOf = $derived(new Map(doubles.map((d) => [d.instrument, d])));
  const PARTS_HINT =
    "Players of one instrument written on several staves (Fl. I and Fl. II, Vc. and Kb.) are one instrument with parts: choose the instrument and its part, not an instrument of their own.";
  const doubleTitle = (id: string) => {
    const d = doubleOf.get(id);
    if (!d) return "";
    const like = nameOf(d.like);
    return `${d.how === "same" ? `The same name as ${like}` : d.how === "longer" ? `${like} with more after it` : `A part of ${like}`}: possibly ${like} named a second time. ${PARTS_HINT}`;
  };

  // What a merge makes of an instrument named a second time: the instrument
  // it joins and the parts of its staves ("Flöte, part I"); null when it
  // cannot be merged.
  function mergeResult(d: DoubleNaming): string | null {
    const r = mergeInstrument(named, d);
    if (!r) return null;
    const like = r.named.instruments.find((i) => i.id === d.like)!;
    const labels = [
      ...new Set(
        [...r.staves.values()].map((id) =>
          partsLabel(like, like.staves.find((s) => s.id === id)!),
        ),
      ),
    ].filter((l) => l);
    return labels.length
      ? `${like.name}, part${labels.length > 1 || /[.]/.test(labels[0]) ? "s" : ""} ${labels.join(", ")}`
      : like.name;
  }

  // An instrument's staves by the parts they carry: one list per
  // combination, a grand staff's several staves together.
  const combinations = (instrument: LayoutInstrument) => [
    ...instrument.staves
      .reduce((m, staff) => {
        const key = staff.parts.join(",");
        return m.set(key, [...(m.get(key) ?? []), staff]);
      }, new Map<string, LayoutInstrument["staves"]>())
      .values(),
  ];

  const NEW = "new";
  const OTHER = "other";
  const nameList = "instrument-names";

  const naming = $derived(
    pages.map((pg) => ({
      zones: pg.zones,
      staves: pg.staves ?? [],
      grandstaves: pg.grandstaves ?? [],
    })),
  );
  const units = $derived(namingUnits(naming));
  const first = $derived(firstNamingSystem(naming));

  // More instruments than the first system has staves (a grand staff
  // counted once) means some were named again or added later; those not in
  // the first system are listed.
  const firstCount = $derived(units.filter((u) => inSystem(first, u)).length);
  const outsideFirst = $derived.by(() => {
    const inFirst = new Set(
      units
        .filter((u) => inSystem(first, u))
        .flatMap((u) => {
          const shown = shownOf(u);
          return shown ? [shown.instrument.id] : [];
        }),
    );
    return named.instruments.filter((i) => !inFirst.has(i.id));
  });
  // The units shown: the first system's while its instruments are named;
  // once they are confirmed, those of the other systems, and to a viewer who
  // cannot edit, all of them.
  const shownUnits = $derived(
    units.filter((u) =>
      !named.fixed ? inSystem(first, u) : !canEdit || !inSystem(first, u),
    ),
  );
  // The pages of the shown units; once the instruments are confirmed, also
  // the pages without staves.
  const shownPages = $derived(
    naming
      .map((_, p) => p)
      .filter(
        (p) =>
          shownUnits.some((u) => u.page === p) ||
          (named.fixed && !units.some((u) => u.page === p)),
      ),
  );

  // The summary: per instrument the pages it is named on, as ranges
  // ("1–3, 5").
  const pagesOf = $derived.by(() => {
    const ids = new Map<string, Set<number>>();
    naming.forEach((pg, p) =>
      pg.staves.forEach((box) => {
        const instrument = named.instruments.find((i) =>
          i.staves.some((s) => s.id === box.staff),
        );
        if (instrument)
          ids.set(instrument.id, (ids.get(instrument.id) ?? new Set()).add(p));
      }),
    );
    return ids;
  });
  function ranges(pagesSet: Set<number> | undefined): string {
    const list = [...(pagesSet ?? [])].sort((a, b) => a - b).map((p) => p + 1);
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      let j = i;
      while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
      out.push(j > i ? `${list[i]}–${list[j]}` : `${list[i]}`);
      i = j;
    }
    return out.join(", ");
  }
  const nameOf = (id: string) =>
    named.instruments.find((i) => i.id === id)?.name ?? "";

  // A strip is drawn at the smallest scale that keeps its field rows apart
  // (ROW_PX between the centres of neighbouring units) and its staves at
  // least STAFF_PX high, and never above the image's own size.
  const ROW_PX = 38;
  const STAFF_PX = 24;

  // The scale of a strip whose rows are `list`'s units; null for none.
  function scaleFor(list: NamingUnit[]): number | null {
    if (!list.length) return null;
    const pg = naming[list[0].page];
    const boxes = list.flatMap((u) => u.staves.map((i) => pg.staves[i]));
    const centres = list.map(centre).sort((a, b) => a - b);
    const gap = Math.min(...centres.slice(1).map((c, k) => c - centres[k]));
    const staffHeight = Math.min(...boxes.map((b) => b.lry - b.uly));
    return Math.min(1, Math.max(ROW_PX / gap, STAFF_PX / staffHeight));
  }

  // The strips: per page, per system, the part of the page shown, its scale
  // and the system's units. A system's strip runs from the page's left edge
  // to the end of its first measure, from a little above its top staff to a
  // little below its bottom one. With `whole`, each page is one strip of the
  // whole page, at the scale its units need (pages without staves at the
  // largest of the others), so every page shows, its fields those shown.
  const strips = $derived.by(() => (whole ? wholeStrips() : openingStrips()));
  function wholeStrips() {
    const scales = naming.map((_, p) =>
      scaleFor(units.filter((u) => u.page === p)),
    );
    const fallback = Math.max(0, ...scales.map((k) => k ?? 0)) || 0.3;
    return naming.map((_, p) => ({
      page: p,
      systems: [
        {
          system: -1,
          units: shownUnits.filter((u) => u.page === p),
          view: { ulx: 0, uly: 0, lrx: pages[p].width, lry: pages[p].height },
          scale: scales[p] ?? fallback,
        },
      ],
    }));
  }
  function openingStrips() {
    return shownPages.map((p) => {
      const pg = naming[p];
      const firstZones: number[] = [];
      pg.zones.forEach((zone, i) => {
        if (i === 0 || zone.pb || zone.sb) firstZones.push(i);
      });
      const systems = new Map<number, NamingUnit[]>();
      for (const unit of shownUnits.filter((u) => u.page === p)) {
        systems.set(unit.system, [...(systems.get(unit.system) ?? []), unit]);
      }
      return {
        page: p,
        systems: [...systems.entries()].map(([s, list]) => {
          const boxes = list.flatMap((u) => u.staves.map((i) => pg.staves[i]));
          const height = Math.max(...boxes.map((b) => b.lry - b.uly));
          const pad = height * 0.6;
          const uly = Math.max(0, Math.min(...boxes.map((b) => b.uly)) - pad);
          const lry = Math.min(
            pages[p].height,
            Math.max(...boxes.map((b) => b.lry)) + pad,
          );
          const left = Math.min(...boxes.map((b) => b.ulx));
          const right = Math.max(...boxes.map((b) => b.lrx));
          const measureEnd = pg.zones[firstZones[s] ?? -1]?.box.lrx;
          const lrx = Math.min(
            pages[p].width,
            (measureEnd ?? left + (right - left) * 0.3) + height * 0.3,
          );
          return {
            system: s,
            units: list,
            view: { ulx: 0, uly, lrx, lry },
            scale: scaleFor(list) ?? 1,
          };
        }),
      };
    });
  }

  const shownOf = (unit: NamingUnit) =>
    unitName(named, naming[unit.page], unit);
  const centre = (unit: NamingUnit) => {
    const pg = naming[unit.page];
    const top = pg.staves[unit.staves[0]].uly;
    const bottom = pg.staves[unit.staves[unit.staves.length - 1]].lry;
    return (top + bottom) / 2;
  };
  const where = (unit: NamingUnit, list: NamingUnit[]) =>
    `Page ${unit.page + 1}, system ${unit.system + 1}, ${unit.staves.length > 1 ? "grand staff" : "staff"} ${list.indexOf(unit) + 1}`;
  const fitting = (unit: NamingUnit) =>
    named.instruments.filter((i) => i.grand === unit.staves.length > 1);

  // Units whose "New instrument" or "Other parts" field is open.
  let adding = $state<Record<string, boolean>>({});
  let otherParts = $state<Record<string, boolean>>({});
  const keyOf = (unit: NamingUnit) => `${unit.page}/${unit.staves.join("-")}`;

  function pickInstrument(unit: NamingUnit, value: string) {
    const key = keyOf(unit);
    if (value === NEW) {
      adding[key] = true;
      return;
    }
    adding[key] = false;
    otherParts[key] = false;
    if (!value) ondefine(unit, "", "");
    else onassign(unit, value, []);
  }

  function pickParts(unit: NamingUnit, instrument: string, value: string) {
    const key = keyOf(unit);
    if (value === OTHER) {
      otherParts[key] = true;
      return;
    }
    otherParts[key] = false;
    onassign(
      unit,
      instrument,
      value === "" ? [] : value.split(",").map(Number),
    );
  }

  // Groups of instruments.
  function addGroup() {
    const ids = named.instruments.map((i) => i.id);
    if (!ids.length) return;
    const used = named.groups.map((g) =>
      Number(/^g(\d+)$/.exec(g.id)?.[1] ?? 0),
    );
    ongroups([
      ...named.groups,
      {
        id: `g${Math.max(0, ...used) + 1}`,
        first: ids[0],
        last: ids[ids.length - 1],
        symbol: "bracket",
        label: "",
        barThru: false,
      },
    ]);
  }
  const position = (id: string) =>
    named.instruments.findIndex((i) => i.id === id);

  // The structure column beside a strip: the marks of a score's left margin
  // that the names make, system by system: a brace for a grand staff, a
  // bracket for neighbouring staves of one instrument, a bar for a group of
  // instruments (an outer group further left). Positions are fractions of
  // the strip's height.
  type Mark = {
    kind: "brace" | "bracket" | "group";
    top: number;
    bottom: number;
    depth: number;
    title: string;
  };
  function marksOf(
    list: NamingUnit[],
    view: { uly: number; lry: number },
  ): Mark[] {
    const h = view.lry - view.uly;
    const span = (run: NamingUnit[]) => {
      const pg = naming[run[0].page];
      const last = run[run.length - 1];
      return {
        top: (pg.staves[run[0].staves[0]].uly - view.uly) / h,
        bottom:
          (pg.staves[last.staves[last.staves.length - 1]].lry - view.uly) / h,
      };
    };
    const systems = new Map<string, NamingUnit[]>();
    for (const u of list) {
      const k = `${u.page}/${u.system}`;
      systems.set(k, [...(systems.get(k) ?? []), u]);
    }
    const marks: Mark[] = [];
    for (const units of systems.values()) {
      const ids = units.map((u) => shownOf(u)?.instrument.id ?? null);
      for (let i = 0; i < units.length; i++) {
        const shown = shownOf(units[i]);
        if (!shown) continue;
        const instrument = shown.instrument;
        let j = i;
        while (j + 1 < units.length && ids[j + 1] === instrument.id) j++;
        // A grand staff's brace, also each of one instrument's several
        // (Harfe 1, Harfe 2), which get no bracket.
        for (const unit of units.slice(i, j + 1))
          if (instrument.grand)
            marks.push({
              kind: "brace",
              ...span([unit]),
              depth: 0,
              title: [
                instrument.name,
                partsLabel(instrument, shownOf(unit)!.staff),
              ]
                .filter((t) => t)
                .join(" "),
            });
        if (j > i && !instrument.grand)
          marks.push({
            kind: "bracket",
            ...span(units.slice(i, j + 1)),
            depth: 0,
            title: instrument.name,
          });
        i = j;
      }
      const runs = named.groups.flatMap((g, k) => {
        const a = position(g.first);
        const b = position(g.last);
        const inside = units.filter((_, n) => {
          const at = ids[n] ? position(ids[n]!) : -1;
          return at >= a && at <= b;
        });
        return inside.length ? [{ k, a, b, inside, g }] : [];
      });
      for (const r of runs) {
        const depth = runs.filter(
          (o) =>
            o !== r &&
            o.a <= r.a &&
            o.b >= r.b &&
            (o.b - o.a > r.b - r.a || o.k < r.k),
        ).length;
        marks.push({
          kind: "group",
          ...span(r.inside),
          depth,
          title: `${r.g.label || "Group"}: ${nameOf(r.g.first)} to ${nameOf(r.g.last)}`,
        });
      }
    }
    return marks;
  }
  function setGroup(k: number, change: Partial<LayoutGroup>) {
    const groups = named.groups.map((g, i) =>
      i === k ? { ...g, ...change } : g,
    );
    const g = groups[k];
    // The first instrument comes before the last one.
    if (position(g.first) > position(g.last))
      groups[k] = change.first
        ? { ...g, last: g.first }
        : { ...g, first: g.last };
    ongroups(groups);
  }
</script>

<datalist id={nameList}>
  {#each named.instruments as instrument (instrument.id)}
    <option value={instrument.name}></option>
  {/each}
</datalist>

<div class="naming">
  {#if canEdit}
    <div class="seg systems-tabs" role="tablist" aria-label="Systems">
      <button
        type="button"
        role="tab"
        aria-selected={!named.fixed}
        class:on={!named.fixed}
        title="Name the instruments of the first system, their parts and the groups. The other systems keep their choices."
        onclick={() => named.fixed && onfix(false)}>First system</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={named.fixed}
        aria-disabled={!named.fixed && fixBlock !== null}
        class:on={named.fixed}
        class:blocked={!named.fixed && fixBlock !== null}
        title={!named.fixed && fixBlock
          ? fixBlock
          : "Choose for every staff of the other systems an instrument of the first system and its parts."}
        onclick={() => !named.fixed && fixBlock === null && onfix(true)}
        >Other systems</button
      >
    </div>
  {/if}
  <p
    class="phase"
    title="The automatic recognition reads each staff on its own and cannot tell which instrument the staff belongs to. These names put every recognised staff on the right staff of the score and make its list of instruments."
  >
    {#if named.fixed}
      {#if canEdit}
        Choose, for every staff of the other systems, the instrument and the
        parts it carries.
      {:else}
        The instrument of every staff, system by system.
      {/if}
    {:else}
      Name the instruments of the first system, on page {(first?.page ?? 0) +
        1}: for every staff its full and short name and the parts it carries,
      for every grand staff its names.
    {/if}
  </p>

  {#if firstCount > 0 && named.instruments.length > firstCount}
    <p
      class="doubles"
      title={`Every instrument usually appears in the first system, so the piece has as many instruments as the first system has staves, or fewer where an instrument has several staves. ${PARTS_HINT} Instruments that enter later are added with New instrument… and marked new.`}
    >
      <Icon name="warning" size={14} />
      <span>
        {named.instruments.length} instruments are named, the first system has {firstCount}
        {firstCount === 1 ? "staff" : "staves"}. Not in the first system:
        {#each outsideFirst as instrument, i (instrument.id)}{i ? ", " : ""}<b
            >{instrument.name}</b
          >{#if instrument.added}
            (new){/if}{/each}
      </span>
    </p>
  {/if}
  {#if doubles.length}
    <p class="doubles" title={PARTS_HINT}>
      <Icon name="warning" size={14} />
      <span>
        Possibly named twice:
        {#each doubles as d, i (d.instrument)}
          {@const result = canEdit ? mergeResult(d) : null}
          {i ? ", " : ""}<span title={doubleTitle(d.instrument)}
            ><b>{nameOf(d.instrument)}</b> ({nameOf(d.like)})</span
          >{#if result}
            <button
              type="button"
              class="linkish"
              title={`Name its staves ${result} instead. One step, undo restores it.`}
              onclick={() => onmerge(d)}>make it {result}</button
            >{/if}
        {/each}
      </span>
    </p>
  {/if}

  {#if named.fixed && canEdit}
    <section class="summary" aria-label="Instruments and groups">
      <h2 class="list-h">
        Instruments <span class="countpill">{named.instruments.length}</span>
      </h2>
      <div class="sumcard">
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th title="The short name printed from the second system on"
                >Short</th
              >
              <th title="The players of the instrument">Parts</th>
              <th
                title="The staves of the instrument, each with the parts it carries"
                >Staves</th
              >
              <th
                class="num"
                title="The pages on which a staff is named for the instrument"
                >Pages</th
              >
            </tr>
          </thead>
          <tbody>
            {#each named.instruments as instrument (instrument.id)}
              <tr>
                <td class="iname">
                  {instrument.name}
                  {#if doubleOf.has(instrument.id)}
                    {@const d = doubleOf.get(instrument.id)!}
                    {@const result = mergeResult(d)}
                    <span class="dup" title={doubleTitle(instrument.id)}
                      ><Icon name="warning" size={12} /> named twice?</span
                    >
                    {#if result}
                      <button
                        type="button"
                        class="linkish merge"
                        title={`Name its staves ${result} instead. One step, undo restores it.`}
                        onclick={() => onmerge(d)}>Make it {result}</button
                      >
                    {/if}
                  {/if}
                  {#if instrument.added}
                    <span
                      class="added"
                      title={`Added on page ${instrument.added}, not in the first system.`}
                      >new</span
                    >
                  {/if}
                </td>
                <td class="faint">{instrument.abbr}</td>
                <td class="faint">
                  <span class="partlist">
                    {#if instrument.partsAreInstruments}
                      {#each instrument.parts as part, k (k)}
                        <span class="ownpart"
                          >{part.name}
                          <input
                            class="ctl short"
                            type="text"
                            value={part.abbr ?? ""}
                            placeholder="Short"
                            disabled={!canEdit}
                            aria-label={`${instrument.name}, ${part.name}: short name`}
                            title="The short name printed in front of the systems after the first where the staff carries only this instrument, such as Kb."
                            onchange={(e) =>
                              oninstrument(instrument.id, {
                                parts: instrument.parts.map((p, i) =>
                                  i === k
                                    ? {
                                        ...p,
                                        abbr: (
                                          e.target as HTMLInputElement
                                        ).value.trim(),
                                      }
                                    : p,
                                ),
                              })}
                          /></span
                        >
                      {/each}
                    {:else}
                      {instrument.parts.map((part) => part.name).join(", ")}
                    {/if}
                    {#if !instrument.grand && instrument.parts.length > 1}
                      <label
                        class="check"
                        title="Each part is an instrument of its own, such as Violoncello and Kontrabass on a shared staff: a staff of one part is named after it, and each part has its own short name and transposition."
                      >
                        <input
                          type="checkbox"
                          checked={!!instrument.partsAreInstruments}
                          disabled={!canEdit}
                          onchange={(e) =>
                            oninstrument(instrument.id, {
                              partsAreInstruments: (
                                e.target as HTMLInputElement
                              ).checked,
                            })}
                        /> Parts are instruments
                      </label>
                    {/if}
                  </span>
                </td>
                <td>
                  <span class="staves">
                    {#if instrument.grand}
                      {#each combinations(instrument) as list (list[0].id)}
                        <span
                          class="staffpill grand"
                          title="A grand staff: one player, the staves always together (a brace)."
                          >{[
                            partsLabel(instrument, list[0]),
                            `grand staff · ${list.length}`,
                          ]
                            .filter((t) => t)
                            .join(" · ")}</span
                        >
                      {/each}
                    {:else if instrument.parts.length}
                      {#each instrument.staves as staff (staff.id)}
                        <span class="staffpill"
                          >{partsLabel(instrument, staff) || "—"}</span
                        >
                      {/each}
                    {:else}
                      <span class="staffpill">1 staff</span>
                    {/if}
                  </span>
                </td>
                <td class="num faint">{ranges(pagesOf.get(instrument.id))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="sumgroups">
          <span class="grouphead">Groups</span>
          {#each named.groups as group (group.id)}
            <span class="groupline">
              <b>{group.label || "Without label"}</b>
              {nameOf(group.first)} – {nameOf(
                group.last,
              )}{#if group.barThru}<span class="faint">, bar through</span>{/if}
            </span>
          {:else}
            <span class="faint">None</span>
          {/each}
        </div>
      </div>
    </section>
  {/if}

  <div class="columns">
    <div class="pages-col">
      {#each strips as { page: p, systems } (p)}
        <section class="npage" aria-label={`Page ${p + 1}`}>
          <p class="page-label">Page {p + 1}</p>
          {#if !systems.length}
            <p class="muted">No staves on this page.</p>
          {/if}
          {#each systems as strip (strip.system)}
            {@const v = strip.view}
            {@const w = v.lrx - v.ulx}
            {@const h = v.lry - v.uly}
            <div class="strip" class:whole class:readonly={!canEdit}>
              <div class="fields">
                {#each strip.units as unit (unit.staves.join("-"))}
                  {@const shown = shownOf(unit)}
                  {@const key = keyOf(unit)}
                  {@const grand = unit.staves.length > 1}
                  <div
                    class="field-row"
                    class:unnamed={!shown}
                    style:top={`${((centre(unit) - v.uly) / h) * 100}%`}
                  >
                    {#if !canEdit}
                      <span
                        class="named-text"
                        class:missing={!shown}
                        class:double={shown &&
                          doubleOf.has(shown.instrument.id)}
                        title={shown
                          ? doubleTitle(shown.instrument.id)
                          : undefined}
                      >
                        {#if shown}
                          {shown.instrument.name}
                          {#if shown.instrument.parts.length}
                            <span class="parts-text"
                              >{partsLabel(shown.instrument, shown.staff) ||
                                "—"}</span
                            >
                          {/if}
                        {:else}
                          Not named
                        {/if}
                      </span>
                      {#if shown?.instrument.added}
                        <span
                          class="added"
                          title={`Added on page ${shown.instrument.added}, not in the first system.`}
                          >new</span
                        >
                      {/if}
                    {:else if !named.fixed || adding[key]}
                      <input
                        class="ctl name"
                        type="text"
                        list={nameList}
                        value={adding[key]
                          ? ""
                          : (shown?.instrument.name ?? "")}
                        placeholder={grand
                          ? "Instrument (grand staff)"
                          : "Instrument"}
                        disabled={!canEdit}
                        aria-label={`${where(unit, strip.units)}: instrument`}
                        title={named.fixed
                          ? "A new instrument, not in the first system. It is marked for the reviewer."
                          : "The instrument of this staff. The same name on several staves is one instrument; give each staff its parts."}
                        onchange={(e) => {
                          const name = (e.target as HTMLInputElement).value;
                          const row = (e.target as HTMLElement).closest(
                            ".field-row",
                          );
                          const parts =
                            row?.querySelector<HTMLInputElement>("input.parts")
                              ?.value ?? "";
                          ondefine(
                            unit,
                            name,
                            parts,
                            named.fixed ? p + 1 : undefined,
                          );
                          adding[key] = false;
                        }}
                        onkeydown={(e) => {
                          if (e.key === "Escape" && adding[key])
                            adding[key] = false;
                        }}
                      />
                      {#if shown && !adding[key]}
                        {@const instrument = shown.instrument}
                        <input
                          class="ctl short"
                          type="text"
                          value={instrument.abbr}
                          placeholder="Short"
                          disabled={!canEdit}
                          aria-label={`${where(unit, strip.units)}: short name`}
                          title="The short name printed in front of the systems after the first, such as Fl. It is the same for every staff of the instrument."
                          onchange={(e) =>
                            onabbr(
                              instrument.id,
                              (e.target as HTMLInputElement).value,
                            )}
                        />
                      {/if}
                      {#if grand}
                        <span
                          class="kind"
                          title="A grand staff: one player, the staves always together (a brace)."
                          >grand</span
                        >
                      {/if}
                      <input
                        class="ctl parts"
                        type="text"
                        value={shown && !adding[key]
                          ? partsLabel(shown.instrument, shown.staff)
                          : ""}
                        placeholder="Parts"
                        disabled={!canEdit}
                        aria-label={`${where(unit, strip.units)}: parts`}
                        title={grand
                          ? "The player this grand staff is for, as printed: 1 and 2 for Harfe 1 and Harfe 2. Empty for an instrument of one player."
                          : "The players this staff carries, as printed: I, II, or 1.2.3 for three on one staff. Empty for an instrument of one player, or all its parts."}
                        onchange={(e) => {
                          const row = (e.target as HTMLElement).closest(
                            ".field-row",
                          );
                          const name =
                            row?.querySelector<HTMLInputElement>("input.name")
                              ?.value ?? "";
                          if (name)
                            ondefine(
                              unit,
                              name,
                              (e.target as HTMLInputElement).value,
                              named.fixed ? p + 1 : undefined,
                            );
                        }}
                      />
                      {#if adding[key] && canEdit}
                        <button
                          type="button"
                          class="btn"
                          aria-label={`Cancel, ${where(unit, strip.units)}: back to the list`}
                          title="Choose an instrument of the list instead (Esc)"
                          onclick={() => (adding[key] = false)}>Cancel</button
                        >
                      {/if}
                    {:else}
                      <select
                        class="ctl name"
                        value={shown?.instrument.id ?? ""}
                        disabled={!canEdit}
                        aria-label={`${where(unit, strip.units)}: instrument`}
                        title="The instrument of this staff, from the instruments of the first system."
                        onchange={(e) =>
                          pickInstrument(
                            unit,
                            (e.target as HTMLSelectElement).value,
                          )}
                      >
                        <option value="">—</option>
                        {#each fitting(unit) as instrument (instrument.id)}
                          <option value={instrument.id}
                            >{instrument.name}</option
                          >
                        {/each}
                        <option value={NEW}>New instrument…</option>
                      </select>
                      {#if shown && shown.instrument.parts.length}
                        {@const instrument = shown.instrument}
                        {#if otherParts[key]}
                          <input
                            class="ctl parts"
                            type="text"
                            value={partsLabel(instrument, shown.staff)}
                            placeholder="Parts"
                            disabled={!canEdit}
                            aria-label={`${where(unit, strip.units)}: parts`}
                            title="The players this staff carries, as printed: I, II, or 1.2.3. Empty for all its parts."
                            onchange={(e) => {
                              ondefine(
                                unit,
                                instrument.name,
                                (e.target as HTMLInputElement).value,
                              );
                              otherParts[key] = false;
                            }}
                          />
                        {:else}
                          <select
                            class="ctl parts"
                            value={shown.staff.parts.join(",")}
                            disabled={!canEdit}
                            aria-label={`${where(unit, strip.units)}: parts`}
                            title="The parts of the instrument this staff carries."
                            onchange={(e) =>
                              pickParts(
                                unit,
                                instrument.id,
                                (e.target as HTMLSelectElement).value,
                              )}
                          >
                            {#each combinations(instrument) as list (list[0].id)}
                              <option value={list[0].parts.join(",")}
                                >{partsLabel(instrument, list[0])}</option
                              >
                            {/each}
                            {#if instrument.parts.length > 1 && !instrument.staves.some((s) => s.parts.length === instrument.parts.length)}
                              <option value=""
                                >{instrument.parts
                                  .map((part) => part.name)
                                  .join(".")}</option
                              >
                            {/if}
                            {#each instrument.parts as part, i (i)}
                              {#if !instrument.staves.some((s) => s.parts.length === 1 && s.parts[0] === i)}
                                <option value={String(i)}>{part.name}</option>
                              {/if}
                            {/each}
                            <option value={OTHER}>Other parts…</option>
                          </select>
                        {/if}
                      {/if}
                      {#if shown?.instrument.added}
                        <span
                          class="added"
                          title={`Added on page ${shown.instrument.added}, not in the first system.`}
                          >new</span
                        >
                      {/if}
                    {/if}
                  </div>
                {/each}
              </div>
              <div class="structure" aria-hidden="true">
                {#each marksOf(strip.units, v) as m, i (i)}
                  <span
                    class="mark {m.kind}"
                    style:top={`${m.top * 100}%`}
                    style:height={`${(m.bottom - m.top) * 100}%`}
                    style:left={m.kind === "group"
                      ? `${2 + m.depth * 6}px`
                      : undefined}
                    title={m.title}
                  >
                    {#if m.kind === "brace"}
                      <svg viewBox="0 0 10 100" preserveAspectRatio="none">
                        <path
                          d="M9 0 Q3 0 3 8 L3 44 Q3 50 0 50 Q3 50 3 56 L3 92 Q3 100 9 100"
                          vector-effect="non-scaling-stroke"
                        />
                      </svg>
                    {/if}
                  </span>
                {/each}
              </div>
              <div class="cropbox">
                <svg
                  class="crop"
                  viewBox={`${v.ulx} ${v.uly} ${w} ${h}`}
                  style:width={`${w * strip.scale}px`}
                  role="img"
                  aria-label={whole
                    ? `Page ${p + 1}`
                    : `Page ${p + 1}, system ${strip.system + 1}, its beginning`}
                >
                  {#if urls[p]}
                    <image
                      href={urls[p]}
                      x="0"
                      y="0"
                      width={pages[p].width}
                      height={pages[p].height}
                    />
                  {/if}
                  {#each strip.units as unit (unit.staves.join("-"))}
                    {#each unit.staves as i (i)}
                      {@const b = naming[p].staves[i]}
                      <rect
                        class="sbox"
                        class:grand={unit.staves.length > 1}
                        x={b.ulx}
                        y={b.uly}
                        width={b.lrx - b.ulx}
                        height={b.lry - b.uly}
                        vector-effect="non-scaling-stroke"
                      />
                    {/each}
                  {/each}
                </svg>
              </div>
            </div>
          {/each}
        </section>
      {/each}
    </div>

    {#if !named.fixed}
      <section class="groups" aria-label="Groups">
        <h2 class="list-h">Groups</h2>
        {#each named.groups as group, k (group.id)}
          <div class="group-row">
            <select
              class="ctl"
              value={group.first}
              disabled={!canEdit || named.fixed}
              aria-label="First instrument of the group"
              title="The top instrument of the group"
              onchange={(e) =>
                setGroup(k, { first: (e.target as HTMLSelectElement).value })}
            >
              {#each named.instruments as instrument (instrument.id)}
                <option value={instrument.id}>{instrument.name}</option>
              {/each}
            </select>
            <span class="to">to</span>
            <select
              class="ctl"
              value={group.last}
              disabled={!canEdit || named.fixed}
              aria-label="Last instrument of the group"
              title="The bottom instrument of the group"
              onchange={(e) =>
                setGroup(k, { last: (e.target as HTMLSelectElement).value })}
            >
              {#each named.instruments as instrument (instrument.id)}
                <option value={instrument.id}>{instrument.name}</option>
              {/each}
            </select>
            <input
              class="ctl"
              type="text"
              value={group.label}
              placeholder="Label"
              disabled={!canEdit || named.fixed}
              aria-label="Group label"
              title="A name printed for the group, if any."
              onchange={(e) =>
                setGroup(k, { label: (e.target as HTMLInputElement).value })}
            />
            <div
              class="seg"
              role="group"
              aria-label="Barlines"
              title="Whether the barlines run through the group's staves or stop at each staff, as on the page."
            >
              <button
                type="button"
                class:on={group.barThru}
                aria-pressed={group.barThru}
                disabled={!canEdit || named.fixed}
                onclick={() => setGroup(k, { barThru: true })}>Through</button
              >
              <button
                type="button"
                class:on={!group.barThru}
                aria-pressed={!group.barThru}
                disabled={!canEdit || named.fixed}
                onclick={() => setGroup(k, { barThru: false })}
                >Per staff</button
              >
            </div>
            {#if canEdit && !named.fixed}
              <button
                type="button"
                class="btn btn-icon btn-danger"
                onclick={() => ongroups(named.groups.filter((_, i) => i !== k))}
                aria-label="Remove this group"
                title="Remove this group"><Icon name="trash" /></button
              >
            {/if}
          </div>
        {:else}
          <p class="muted">No groups.</p>
        {/each}
        {#if canEdit && !named.fixed}
          <button
            type="button"
            class="btn"
            disabled={!named.instruments.length}
            title="Instruments shown together, such as the woodwinds or the strings."
            onclick={addGroup}><Icon name="plus" />Add group</button
          >
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .naming {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }
  /* The pages' strips, then the groups. */
  .columns {
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  .pages-col {
    display: flex;
    flex-direction: column;
    gap: 28px;
    min-width: 0;
  }
  .phase {
    margin: 0;
    font-size: 14px;
  }
  .npage {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .page-label {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .strip {
    display: grid;
    grid-template-columns: minmax(280px, 340px) 32px minmax(0, 1fr);
    gap: 12px;
    align-items: stretch;
  }
  /* The marks a score's left margin would show for the names. */
  .structure {
    position: relative;
  }
  .mark {
    position: absolute;
  }
  .mark.group {
    width: 3px;
    border-radius: 2px;
    background: var(--ink-faint);
  }
  .mark.bracket {
    right: 6px;
    width: 6px;
    border: 2px solid var(--ink-soft);
    border-right: none;
  }
  .mark.brace {
    right: 4px;
    width: 10px;
  }
  .mark.brace svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .mark.brace path {
    fill: none;
    stroke: var(--ink-grand);
    stroke-width: 2;
  }
  .named-text {
    font-size: 13px;
    line-height: 1.3;
  }
  .named-text.missing,
  .named-text.double {
    color: var(--warn);
  }
  /* The tab of the other systems before the first is named. */
  .systems-tabs {
    align-self: flex-start;
  }
  .systems-tabs > button.blocked {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .doubles {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    padding: 8px 12px;
    max-width: 760px;
    font-size: 13px;
    color: var(--warn);
    background: var(--warn-wash);
    border: 1px solid var(--warn-line);
    border-radius: 8px;
  }
  .doubles :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .doubles b {
    font-weight: 600;
  }
  .merge {
    margin-left: 6px;
    font-size: 12px;
    font-weight: 600;
  }
  .dup {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--warn);
  }
  .parts-text {
    margin-left: 4px;
    color: var(--ink-faint);
  }
  .fields {
    position: relative;
  }
  /* Read-only names sit right beside the structure column. */
  .strip.readonly {
    grid-template-columns: minmax(120px, 240px) 32px minmax(0, 1fr);
    column-gap: 6px;
  }
  .strip.readonly .field-row {
    justify-content: flex-end;
    text-align: right;
  }
  .field-row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    transform: translateY(-50%);
  }
  .field-row .name {
    flex: 1;
    min-width: 0;
  }
  .field-row .parts {
    width: 64px;
  }
  .field-row.unnamed .name:not(:disabled) {
    border-color: var(--warn);
  }
  .kind,
  .added {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .added {
    color: var(--warn);
    font-weight: 600;
    margin-left: 6px;
  }
  /* A whole page keeps the size its rows need and scrolls sideways in its
     box; a system's opening shrinks to the column. */
  .cropbox {
    min-width: 0;
    overflow-x: auto;
  }
  .crop {
    display: block;
    max-width: 100%;
    height: auto;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .strip.whole .crop {
    max-width: none;
  }
  .sbox {
    fill: none;
    stroke: var(--ink-staff);
    stroke-width: 1.5;
  }
  .sbox.grand {
    stroke: var(--ink-grand);
  }
  /* The confirmed instruments, as a card like the pieces table. */
  .summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 760px;
  }
  .sumcard {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .sumcard table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .sumcard th {
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-faint);
    background: var(--bg-inset);
  }
  .sumcard th,
  .sumcard td {
    padding: 7px 12px;
    vertical-align: middle;
  }
  .sumcard tbody tr + tr td {
    border-top: 1px solid var(--line);
  }
  .sumcard .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .iname {
    font-weight: 600;
  }
  .faint {
    color: var(--ink-faint);
  }
  .staves {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .staffpill {
    font-size: 11.5px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 999px;
    background: var(--bg-inset);
    white-space: nowrap;
  }
  .staffpill.grand {
    color: var(--ink-grand);
  }
  .sumgroups {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 16px;
    padding: 9px 12px;
    font-size: 13px;
    border-top: 1px solid var(--line);
  }
  .grouphead {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .groupline b {
    font-weight: 600;
    margin-right: 4px;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 760px;
  }
  .list-h {
    margin: 0;
    font-size: 15px;
  }
  .field-row .short,
  .ownpart .short {
    width: 64px;
  }
  .partlist {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
  }
  .ownpart {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
  }
  .group-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .to {
    font-size: 13px;
    color: var(--ink-faint);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
  }
  @media (max-width: 640px) {
    .strip {
      grid-template-columns: minmax(160px, 52%) 28px minmax(0, 1fr);
    }
    .strip.readonly {
      grid-template-columns: minmax(100px, 40%) 28px minmax(0, 1fr);
    }
  }
</style>
