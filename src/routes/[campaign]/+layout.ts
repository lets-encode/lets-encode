import { error, redirect } from "@sveltejs/kit";
import { isValidHandle } from "$lib/campaign-handle.ts";
import type { LayoutLoad } from "./$types";

// Campaign names are lowercase (broker/slug_validation.py), so a name with
// capitals addresses the campaign of the lowercased name.
export const load: LayoutLoad = ({ params, url }) => {
  const name = params.campaign.toLowerCase();
  // A segment of another shape addresses no campaign; the pages also build
  // links from it.
  if (!isValidHandle(name)) error(404, "Not found");
  if (name !== params.campaign)
    redirect(
      308,
      url.pathname.replace(/^\/[^/]*/, `/${encodeURIComponent(name)}`) +
        url.search,
    );
};
