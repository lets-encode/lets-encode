/**
 * The title of the campaign whose tables were read last, for the top bar's
 * back link. The pages that read a campaign's tables record it here.
 */
export const campaignTitle = $state({ campaign: "", title: "" });

/** Record the title read from a campaign's config.yaml. */
export function recordCampaignTitle(campaign: string, title: string) {
  campaignTitle.campaign = campaign;
  campaignTitle.title = title;
}
