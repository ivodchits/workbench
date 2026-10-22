// The monthly invoice's draft (phase 3): `create_sheet_draft` copies the user's
// invoice sheet into Duck's drafts folder in Drive and sets this month's cells in
// the copy. The original is never changed (the Google scopes can't), and sending
// stays with the user.
//
// The plan is worked out before the card (`prepare`): the configured cells are read
// from the sheet as they are now, and each one's rule gives its new value
// (`invoice.ts`). The card shows each change, old → new; the backend checks the
// original still holds what the card showed before it copies. Consequential: the
// card shows on every draft unless a trust rule says otherwise.

import { z } from "zod";
import { askedFields, cellsToRead, changeLine, planDraft, type DraftPlan } from "../invoice";
import { isoDate } from "./morning";
import { compact } from "./read";
import { googleErrorText, isGoogleExpired } from "../google";
import { defineTool, type PrepareEnv } from "./registry";

interface Prepared {
  sheet: string;
  folder: string;
  plan: DraftPlan;
}

function setUp(env: PrepareEnv | undefined) {
  const inv = env?.settings.morning.invoice;
  const clientId = env?.settings.morning.googleClientId;
  if (!inv || !clientId || !env?.google)
    throw new Error("the invoice sheet or Google isn't set up (Duck's settings, morning)");
  return { inv, clientId, google: env.google };
}

/** Google's error in a sentence the user can act on. */
const why = (e: unknown) =>
  isGoogleExpired(e) ? "Google access expired: reconnect in Duck's settings (morning)" : googleErrorText(e);

export const createSheetDraft = defineTool({
  name: "create_sheet_draft",
  description:
    "Draft this month's invoice: copy the user's invoice sheet (Duck's settings, morning) into Duck's drafts folder in Google Drive and set the configured cells in the copy, each from its rule (dates, amounts). The original is never changed and nothing is sent. Amounts the settings say to ask for go in `amounts`, by their label: ask the user first. One draft per month. Shows the user a card with each change first.",
  schema: z.object({
    amounts: z
      .record(z.string().max(60), z.number().finite())
      .optional()
      .describe('The amounts the user gave for cells set to "ask me", by label, e.g. {"Hours": 160}.'),
  }),
  tier: "consequential",
  timeoutMs: 90_000,
  async prepare({ amounts }, _port, env): Promise<Prepared> {
    const { inv, clientId, google } = setUp(env);
    const ask = askedFields(inv).map((f) => f.label);
    if (ask.length && !amounts) throw new Error(`ask the user for ${ask.join(", ")} first, then pass it in amounts`);
    let now;
    try {
      now = await google.cells(clientId, inv, cellsToRead(inv));
    } catch (e) {
      throw new Error(`the sheet couldn't be read: ${why(e)}`);
    }
    const plan = planDraft(inv, now.name, now.cells, isoDate(new Date()), amounts);
    if (!plan.changes.length) throw new Error("nothing to change: every configured cell already has this month's value");
    return { sheet: now.name, folder: inv.draftFolder, plan };
  },
  describe(_input, _port, p) {
    const kept = p.plan.kept.length ? ` Unchanged: ${p.plan.kept.map((k) => `${k.label} (${k.why})`).join("; ")}.` : "";
    return `Copy "${p.sheet}" as "${p.plan.title}" into the Drive folder "${p.folder}" and set ${p.plan.changes.map(changeLine).join("; ")}.${kept} The original isn't changed.`;
  },
  trust: () => ({ projectId: null }),
  async run(_input, ctx) {
    const { inv, clientId, google } = setUp(ctx);
    const { plan } = ctx.prepared;
    try {
      const d = await google.draft(clientId, inv, {
        title: plan.title,
        month: plan.month,
        expect: plan.expect,
        updates: plan.changes.map((c) => ({ address: c.address, value: c.to })),
      });
      return {
        draft: d.name,
        link: d.url,
        cells: inv.fields.map((f) => {
          const c = d.cells.find((x) => x.address === f.address);
          return compact({ label: f.label, cell: f.address, value: c?.value ?? "", formula: c?.formula });
        }),
        ...(d.how === "upload" && { note: "Drive refused a direct copy, so the sheet was uploaded as a new one: check its formatting." }),
        next: "Give the user the link to check it. Sending it is theirs to do.",
      };
    } catch (e) {
      throw new Error(`the draft wasn't made: ${why(e)}`);
    }
  },
});

export const INVOICE_TOOLS = [createSheetDraft];
