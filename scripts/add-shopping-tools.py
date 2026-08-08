from pathlib import Path

path = Path('api/mcp.js')
text = path.read_text()

if "google_ads_create_standard_shopping_campaign_paused" in text:
    print('Shopping MCP tools are already present.')
    raise SystemExit(0)

marker = "\n  },\n  { name: 'Pure Majesty Google Ads + GA4', version: '1.0.0' },"
index = text.rfind(marker)
if index < 0:
    raise SystemExit('Could not locate the MCP tool registry closing marker.')

insertion = r'''

    server.registerTool('google_ads_linked_merchant_centers', {
      title: 'Linked Google Merchant Center accounts',
      description: 'Read the Merchant Center account IDs linked to the configured Google Ads customer. Use this before creating a Shopping campaign.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id }) => {
      try {
        const q = `SELECT product_link.resource_name, product_link.product_link_id, product_link.type, product_link.merchant_center.merchant_center_id FROM product_link WHERE product_link.type = MERCHANT_CENTER ORDER BY product_link.product_link_id`;
        return textResult(await gaql(q, customer_id));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_set_ad_group_status', {
      title: 'Set Google Ads ad group status',
      description: 'WRITE ACTION. Enable or pause an existing Google Ads ad group. Enabling an ad group can allow spend when its campaign and ads are also enabled.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        ad_group_id: z.string().regex(/^\d+$/),
        status: z.enum(['ENABLED', 'PAUSED']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, ad_group_id, status }) => {
      try {
        const cid = normalizeCustomerId(customer_id);
        return textResult(await googleAdsFetch(`/customers/${cid}/adGroups:mutate`, {
          operations: [{
            update: { resourceName: `customers/${cid}/adGroups/${ad_group_id}`, status },
            updateMask: 'status',
          }],
          responseContentType: 'MUTABLE_RESOURCE',
        }));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_set_ad_group_ad_status', {
      title: 'Set Google Ads ad status',
      description: 'WRITE ACTION. Enable or pause an ad within an ad group. Enabling an ad can allow spend when its campaign and ad group are also enabled.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        ad_group_id: z.string().regex(/^\d+$/),
        ad_id: z.string().regex(/^\d+$/),
        status: z.enum(['ENABLED', 'PAUSED']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, ad_group_id, ad_id, status }) => {
      try {
        const cid = normalizeCustomerId(customer_id);
        return textResult(await googleAdsFetch(`/customers/${cid}/adGroupAds:mutate`, {
          operations: [{
            update: { resourceName: `customers/${cid}/adGroupAds/${ad_group_id}~${ad_id}`, status },
            updateMask: 'status',
          }],
          responseContentType: 'MUTABLE_RESOURCE',
        }));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_set_ad_group_cpc_bid', {
      title: 'Set Google Ads ad group CPC bid',
      description: 'WRITE ACTION. Change an ad group default CPC bid. This can directly affect traffic volume and advertising spend.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        ad_group_id: z.string().regex(/^\d+$/),
        cpc_bid: z.number().positive().max(10000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, ad_group_id, cpc_bid }) => {
      try {
        const cid = normalizeCustomerId(customer_id);
        return textResult(await googleAdsFetch(`/customers/${cid}/adGroups:mutate`, {
          operations: [{
            update: {
              resourceName: `customers/${cid}/adGroups/${ad_group_id}`,
              cpcBidMicros: micros(cpc_bid),
            },
            updateMask: 'cpc_bid_micros',
          }],
          responseContentType: 'MUTABLE_RESOURCE',
        }));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_set_listing_group_cpc_bid', {
      title: 'Set Shopping product group CPC bid',
      description: 'WRITE ACTION. Change the CPC bid of a Shopping listing-group criterion (called a product group in Google Ads). This can directly affect spend.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        ad_group_id: z.string().regex(/^\d+$/),
        criterion_id: z.string().regex(/^\d+$/),
        cpc_bid: z.number().positive().max(10000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, ad_group_id, criterion_id, cpc_bid }) => {
      try {
        const cid = normalizeCustomerId(customer_id);
        return textResult(await googleAdsFetch(`/customers/${cid}/adGroupCriteria:mutate`, {
          operations: [{
            update: {
              resourceName: `customers/${cid}/adGroupCriteria/${ad_group_id}~${criterion_id}`,
              cpcBidMicros: micros(cpc_bid),
            },
            updateMask: 'cpc_bid_micros',
          }],
          responseContentType: 'MUTABLE_RESOURCE',
        }));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_create_standard_shopping_campaign_paused', {
      title: 'Create a paused Standard Shopping campaign',
      description: 'WRITE ACTION. Creates a Standard Shopping campaign, budget, Shopping ad group, product ad, and an All products listing group. The campaign and product ad are created PAUSED, so the campaign cannot serve until they are separately reviewed and enabled.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        merchant_center_id: z.string().regex(/^\d+$/),
        campaign_name: z.string().min(1).max(128),
        daily_budget: z.number().positive().max(100000),
        campaign_priority: z.number().int().min(0).max(2).default(0),
        feed_label: z.string().min(1).max(20).regex(/^[A-Z0-9_-]+$/).optional(),
        enable_local_inventory: z.boolean().default(false),
        ad_group_name: z.string().min(1).max(255),
        default_cpc_bid: z.number().positive().max(10000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (args) => {
      const created = {};
      try {
        const cid = normalizeCustomerId(args.customer_id);
        const budgetResp = await googleAdsFetch(`/customers/${cid}/campaignBudgets:mutate`, {
          operations: [{ create: {
            name: `${args.campaign_name} Budget ${Date.now()}`,
            amountMicros: micros(args.daily_budget),
            deliveryMethod: 'STANDARD',
            explicitlyShared: false,
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const budgetResource = budgetResp?.results?.[0]?.resourceName || budgetResp?.results?.[0]?.campaignBudget?.resourceName;
        if (!budgetResource) throw new Error(`Budget created but no resource name returned: ${JSON.stringify(budgetResp)}`);
        created.budget = budgetResource;

        const shoppingSetting = {
          merchantId: args.merchant_center_id,
          campaignPriority: args.campaign_priority,
          enableLocal: args.enable_local_inventory,
        };
        if (args.feed_label) shoppingSetting.feedLabel = args.feed_label;

        const campaignResp = await googleAdsFetch(`/customers/${cid}/campaigns:mutate`, {
          operations: [{ create: {
            name: args.campaign_name,
            status: 'PAUSED',
            advertisingChannelType: 'SHOPPING',
            campaignBudget: budgetResource,
            containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
            manualCpc: {},
            shoppingSetting,
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const campaignResource = campaignResp?.results?.[0]?.resourceName || campaignResp?.results?.[0]?.campaign?.resourceName;
        if (!campaignResource) throw new Error(`Campaign created but no resource name returned: ${JSON.stringify(campaignResp)}`);
        created.campaign = campaignResource;

        const adGroupResp = await googleAdsFetch(`/customers/${cid}/adGroups:mutate`, {
          operations: [{ create: {
            name: args.ad_group_name,
            campaign: campaignResource,
            status: 'ENABLED',
            type: 'SHOPPING_PRODUCT_ADS',
            cpcBidMicros: micros(args.default_cpc_bid),
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const adGroupResource = adGroupResp?.results?.[0]?.resourceName || adGroupResp?.results?.[0]?.adGroup?.resourceName;
        if (!adGroupResource) throw new Error(`Ad group created but no resource name returned: ${JSON.stringify(adGroupResp)}`);
        created.ad_group = adGroupResource;

        const adResp = await googleAdsFetch(`/customers/${cid}/adGroupAds:mutate`, {
          operations: [{ create: {
            adGroup: adGroupResource,
            status: 'PAUSED',
            ad: { shoppingProductAd: {} },
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const adResource = adResp?.results?.[0]?.resourceName || adResp?.results?.[0]?.adGroupAd?.resourceName;
        if (!adResource) throw new Error(`Shopping ad created but no resource name returned: ${JSON.stringify(adResp)}`);
        created.ad = adResource;

        const listingResp = await googleAdsFetch(`/customers/${cid}/adGroupCriteria:mutate`, {
          operations: [{ create: {
            adGroup: adGroupResource,
            status: 'ENABLED',
            listingGroup: { type: 'UNIT' },
            cpcBidMicros: micros(args.default_cpc_bid),
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const listingResource = listingResp?.results?.[0]?.resourceName || listingResp?.results?.[0]?.adGroupCriterion?.resourceName;
        if (!listingResource) throw new Error(`Listing group created but no resource name returned: ${JSON.stringify(listingResp)}`);
        created.all_products_listing_group = listingResource;

        return textResult({
          safety: 'The campaign and Shopping product ad were created PAUSED. No ads can serve until the ad and campaign are separately enabled after review.',
          activation_order: [
            'Review the budget, Merchant Center link, feed label, targeting, bid, product eligibility, and conversion tracking.',
            'Enable the Shopping product ad with google_ads_set_ad_group_ad_status.',
            'Enable the campaign with google_ads_set_campaign_status only when ready to spend.',
          ],
          resources: created,
          responses: {
            budget: budgetResp,
            campaign: campaignResp,
            ad_group: adGroupResp,
            ad: adResp,
            listing_group: listingResp,
          },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return errorResult(new Error(`${message}\nResources created before the failure (all remain under a paused campaign when the campaign exists): ${JSON.stringify(created)}`));
      }
    });'''

text = text[:index] + insertion + text[index:]
text = text.replace(
    "{ name: 'Pure Majesty Google Ads + GA4', version: '1.0.0' }",
    "{ name: 'Pure Majesty Google Ads + GA4', version: '1.3.0' }",
)
path.write_text(text)
