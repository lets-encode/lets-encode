<!--
  The instruments step of an 'omr-instruments' layout task, in two parts.
  First the instruments of the piece's first page: every system of that page
  as a strip of its opening (the printed names, clefs, key and meter up to the
  end of its first measure) with, beside each single staff, the instrument
  and the parts the staff carries ("I", "1.2.3"), and beside each grand staff
  the instrument; below, the instruments with their full and short names, and
  the groups of instruments. Once the volunteer has fixed them, the other
  pages: each single staff and grand staff picks an instrument of the list and
  which of its parts the staff carries. An instrument added there is marked
  with its page for the reviewer.
-->
<script lang="ts">
  import type { PageModel } from "$lib/mei-facsimile.ts";
  import type { LayoutGroup, LayoutInstruments } from "$lib/omr-layout.ts";
  import {
    firstNamingPage,
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
    ondefine,
    onassign,
    onabbr,
    ongroups,
  }: {
    /** The pages with their corrected boxes; staff boxes carry their named staff. */
    pages: PageModel[];
    /** Per page, its image URL ('' when it could not be loaded). */
    urls: string[];
    named: LayoutInstruments;
    canEdit: boolean;
    /** Name a unit by instrument name and parts ('' clears it); `added` is the 1-based page of an instrument added after the first page. */
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
    ongroups: (groups: LayoutGroup[]) => void;
  } = $props();

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
  const first = $derived(firstNamingPage(naming));
  const shownPages = $derived(
    named.fixed
      ? naming.map((_, p) => p).filter((p) => p !== first)
      : first >= 0
        ? [first]
        : [],
  );

  // A strip is drawn at the smallest scale that keeps its field rows apart
  // (ROW_PX between the centres of neighbouring units) and its staves at
  // least STAFF_PX high, and never above the image's own size.
  const ROW_PX = 38;
  const STAFF_PX = 24;

  // The strips: per page, per system, the part of the page shown, its scale
  // and the system's units. A system's strip runs from the page's left edge
  // to the end of its first measure, from a little above its top staff to a
  // little below its bottom one.
  const strips = $derived.by(() =>
    shownPages.map((p) => {
      const pg = naming[p];
      const firstZones: number[] = [];
      pg.zones.forEach((zone, i) => {
        if (i === 0 || zone.pb || zone.sb) firstZones.push(i);
      });
      const systems = new Map<number, NamingUnit[]>();
      for (const unit of units.filter((u) => u.page === p)) {
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
          const centres = list.map(centre).sort((a, b) => a - b);
          const gap = Math.min(
            ...centres.slice(1).map((c, k) => c - centres[k]),
          );
          const staffHeight = Math.min(...boxes.map((b) => b.lry - b.uly));
          const scale = Math.min(
            1,
            Math.max(ROW_PX / gap, STAFF_PX / staffHeight),
          );
          return {
            system: s,
            units: list,
            view: { ulx: 0, uly, lrx, lry },
            scale,
          };
        }),
      };
    }),
  );

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
  <p class="phase">
    {#if named.fixed}
      The instruments of page {first + 1} are confirmed. Choose, for every staff of
      the other pages, the instrument and the parts it carries.
    {:else}
      Name the instruments of page {first + 1}, the first page: for every staff
      its full and short name and the parts it carries, for every grand staff
      its names.
    {/if}
  </p>

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
            <div class="strip">
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
                    {#if !named.fixed || adding[key]}
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
                          ? "A new instrument, not on the first page. It is marked for the reviewer."
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
                      {:else}
                        <input
                          class="ctl parts"
                          type="text"
                          value={shown && !adding[key]
                            ? partsLabel(shown.instrument, shown.staff)
                            : ""}
                          placeholder="Parts"
                          disabled={!canEdit}
                          aria-label={`${where(unit, strip.units)}: parts`}
                          title="The players this staff carries, as printed: I, II, or 1.2.3 for three on one staff. Empty for an instrument of one player, or all its parts."
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
                      {/if}
                    {:else}
                      <select
                        class="ctl name"
                        value={shown?.instrument.id ?? ""}
                        disabled={!canEdit}
                        aria-label={`${where(unit, strip.units)}: instrument`}
                        title="The instrument of this staff, from the instruments of the first page."
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
                      {#if shown && !grand && shown.instrument.parts.length}
                        {@const instrument = shown.instrument}
                        {#if otherParts[key]}
                          <input
                            class="ctl parts"
                            type="text"
                            placeholder="Parts"
                            disabled={!canEdit}
                            aria-label={`${where(unit, strip.units)}: parts`}
                            title="The players this staff carries, as printed: I, II, or 1.2.3."
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
                            {#each instrument.staves as staff (staff.id)}
                              <option value={staff.parts.join(",")}
                                >{partsLabel(instrument, staff)}</option
                              >
                            {/each}
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
                          title={`Added on page ${shown.instrument.added}, not on the first page.`}
                          >new</span
                        >
                      {/if}
                    {/if}
                  </div>
                {/each}
              </div>
              <svg
                class="crop"
                viewBox={`${v.ulx} ${v.uly} ${w} ${h}`}
                style:width={`${w * strip.scale}px`}
                role="img"
                aria-label={`Page ${p + 1}, system ${strip.system + 1}, its beginning`}
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
            <label
              class="check"
              title="The barlines run through the group's staves."
            >
              <input
                type="checkbox"
                checked={group.barThru}
                disabled={!canEdit || named.fixed}
                onchange={(e) =>
                  setGroup(k, {
                    barThru: (e.target as HTMLInputElement).checked,
                  })}
              /> Bar through
            </label>
            {#if canEdit && !named.fixed}
              <button
                type="button"
                class="btn btn-secondary"
                onclick={() => ongroups(named.groups.filter((_, i) => i !== k))}
                >Remove</button
              >
            {/if}
          </div>
        {:else}
          <p class="muted">No group.</p>
        {/each}
        {#if canEdit && !named.fixed}
          <button
            type="button"
            class="btn btn-secondary"
            disabled={!named.instruments.length}
            title="Instruments shown together, such as the woodwinds or the strings."
            onclick={addGroup}>Add a group</button
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
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
    gap: 12px;
    align-items: stretch;
  }
  .fields {
    position: relative;
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
  .crop {
    display: block;
    max-width: 100%;
    height: auto;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .sbox {
    fill: none;
    stroke: var(--ink-staff);
    stroke-width: 1.5;
  }
  .sbox.grand {
    stroke: var(--ink-grand);
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
  .field-row .short {
    width: 64px;
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
      grid-template-columns: minmax(160px, 52%) minmax(0, 1fr);
    }
  }
</style>
