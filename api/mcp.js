import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z } from 'zod';
import { MCP_NON_SECRET_DEFAULTS, MCP_SCOPES, verifySignedToken } from '../lib/mcp-oauth.js';

const GOOGLE_ADS_API_VERSION = 'v25';
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const DEFAULT_CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, '');
const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g, '');
const DEFAULT_GA4_PROPERTY_ID = (process.env.GA4_PROPERTY_ID || MCP_NON_SECRET_DEFAULTS.GA4_PROPERTY_ID).replace(/\D/g, '');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeCustomerId(value) {
  return String(value || DEFAULT_CUSTOMER_ID).replace(/\D/g, '');
}

async function googleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_CLIENT_ID,
    client_secret: requiredEnv('GOOGLE_CLIENT_SECRET'),
    refresh_token: requiredEnv('GOOGLE_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google OAuth refresh failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function googleAdsFetch(path, body) {
  const token = await googleAccessToken();
  const headers = {
    authorization: `Bearer ${token}`,
    'developer-token': requiredEnv('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'content-type': 'application/json',
  };
  if (LOGIN_CUSTOMER_ID) headers['login-customer-id'] = LOGIN_CUSTOMER_ID;
  const res = await fetch(`${GOOGLE_ADS_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Google Ads API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function gaql(query, customerId = DEFAULT_CUSTOMER_ID) {
  const cid = normalizeCustomerId(customerId);
  return googleAdsFetch(`/customers/${cid}/googleAds:search`, { query, pageSize: 10000 });
}

async function ga4RunReport({ propertyId = DEFAULT_GA4_PROPERTY_ID, dateRanges, dimensions = [], metrics = [], dimensionFilter, limit = 1000 }) {
  const token = await googleAccessToken();
  const pid = String(propertyId || DEFAULT_GA4_PROPERTY_ID).replace(/\D/g, '');
  const body = {
    dateRanges,
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit: String(Math.min(Number(limit) || 1000, 10000)),
  };
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GA4 Data API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(error) {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function micros(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Amount must be a positive number.');
  return String(Math.round(n * 1_000_000));
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool('google_ads_campaign_performance', {
      title: 'Google Ads campaign performance',
      description: 'Read campaign performance including spend, impressions, clicks, CPC, conversions, conversion value, CPA and ROAS for a date range.',
      inputSchema: z.object({
        customer_id: z.string().optional().describe('Google Ads customer ID. Defaults to the configured account.'),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, start_date, end_date }) => {
      try {
        const q = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.average_cpc, metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.all_conversions_value, metrics.cost_per_conversion FROM campaign WHERE segments.date BETWEEN '${start_date}' AND '${end_date}' ORDER BY metrics.cost_micros DESC`;
        return textResult(await gaql(q, customer_id));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_conversion_breakdown', {
      title: 'Google Ads conversion breakdown',
      description: 'Read conversions and conversion value broken down by conversion action for a date range.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, start_date, end_date }) => {
      try {
        const q = `SELECT segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.all_conversions, metrics.conversions_value, metrics.all_conversions_value FROM campaign WHERE segments.date BETWEEN '${start_date}' AND '${end_date}' AND metrics.all_conversions > 0 ORDER BY metrics.all_conversions DESC`;
        return textResult(await gaql(q, customer_id));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_search_terms', {
      title: 'Google Ads search terms',
      description: 'Read search terms with spend, clicks and conversions. Availability depends on campaign type and Google Ads privacy thresholds.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, start_date, end_date, limit }) => {
      try {
        const q = `SELECT search_term_view.search_term, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '${start_date}' AND '${end_date}' ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
        return textResult(await gaql(q, customer_id));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_shopping_products', {
      title: 'Google Ads Shopping product performance',
      description: 'Read Shopping product performance by Merchant Center item ID, title, spend, clicks and conversions.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, start_date, end_date, limit }) => {
      try {
        const q = `SELECT segments.product_item_id, segments.product_title, segments.product_type_l1, campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM shopping_performance_view WHERE segments.date BETWEEN '${start_date}' AND '${end_date}' ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;
        return textResult(await gaql(q, customer_id));
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('ga4_funnel_report', {
      title: 'GA4 ecommerce funnel report',
      description: 'Read GA4 ecommerce events and revenue for a date range, optionally broken down by source/medium, campaign or landing page.',
      inputSchema: z.object({
        property_id: z.string().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        breakdown: z.enum(['none', 'sessionSourceMedium', 'sessionCampaignName', 'landingPagePlusQueryString']).default('sessionSourceMedium'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ property_id, start_date, end_date, breakdown }) => {
      try {
        const dimensions = ['eventName'];
        if (breakdown !== 'none') dimensions.push(breakdown);
        const report = await ga4RunReport({
          propertyId: property_id,
          dateRanges: [{ startDate: start_date, endDate: end_date }],
          dimensions,
          metrics: ['eventCount', 'totalUsers', 'purchaseRevenue'],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'] },
            },
          },
          limit: 10000,
        });
        return textResult(report);
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_set_campaign_status', {
      title: 'Set Google Ads campaign status',
      description: 'WRITE ACTION. Enable or pause an existing Google Ads campaign. Enabling a campaign can cause advertising spend.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        campaign_id: z.string().regex(/^\d+$/),
        status: z.enum(['ENABLED', 'PAUSED']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, campaign_id, status }) => {
      try {
        const cid = normalizeCustomerId(customer_id);
        const data = await googleAdsFetch(`/customers/${cid}/campaigns:mutate`, {
          operations: [{
            update: { resourceName: `customers/${cid}/campaigns/${campaign_id}`, status },
            updateMask: 'status',
          }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        return textResult(data);
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_set_daily_budget', {
      title: 'Set Google Ads daily budget',
      description: 'WRITE ACTION. Change the daily campaign budget. This directly changes the amount Google Ads may spend. The currency is the Google Ads account currency.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        campaign_id: z.string().regex(/^\d+$/),
        daily_budget: z.number().positive().max(100000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ customer_id, campaign_id, daily_budget }) => {
      try {
        const cid = normalizeCustomerId(customer_id);
        const lookup = await gaql(`SELECT campaign.id, campaign.name, campaign.campaign_budget FROM campaign WHERE campaign.id = ${campaign_id} LIMIT 1`, cid);
        const budgetResource = lookup?.results?.[0]?.campaign?.campaignBudget;
        if (!budgetResource) throw new Error(`Could not find campaign budget for campaign ${campaign_id}`);
        const data = await googleAdsFetch(`/customers/${cid}/campaignBudgets:mutate`, {
          operations: [{
            update: { resourceName: budgetResource, amountMicros: micros(daily_budget) },
            updateMask: 'amount_micros',
          }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        return textResult(data);
      } catch (e) { return errorResult(e); }
    });

    server.registerTool('google_ads_create_search_campaign_draft', {
      title: 'Create paused Google Ads Search campaign',
      description: 'WRITE ACTION. Creates a complete Search campaign with budget, ad group, keywords and responsive search ad. For safety, the new campaign is always created PAUSED and cannot spend until separately enabled.',
      inputSchema: z.object({
        customer_id: z.string().optional(),
        campaign_name: z.string().min(1).max(128),
        daily_budget: z.number().positive().max(100000),
        ad_group_name: z.string().min(1).max(255),
        default_cpc_bid: z.number().positive().max(10000),
        final_url: z.string().url(),
        keywords: z.array(z.object({
          text: z.string().min(1).max(80),
          match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('PHRASE'),
        })).min(1).max(100),
        headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
        descriptions: z.array(z.string().min(1).max(90)).min(2).max(4),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (args) => {
      try {
        const cid = normalizeCustomerId(args.customer_id);
        const budgetResp = await googleAdsFetch(`/customers/${cid}/campaignBudgets:mutate`, {
          operations: [{ create: { name: `${args.campaign_name} Budget ${Date.now()}`, amountMicros: micros(args.daily_budget), deliveryMethod: 'STANDARD', explicitlyShared: false } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const budgetResource = budgetResp?.results?.[0]?.resourceName || budgetResp?.results?.[0]?.campaignBudget?.resourceName;
        if (!budgetResource) throw new Error(`Budget created but no resource name returned: ${JSON.stringify(budgetResp)}`);

        const campaignResp = await googleAdsFetch(`/customers/${cid}/campaigns:mutate`, {
          operations: [{ create: {
            name: args.campaign_name,
            status: 'PAUSED',
            advertisingChannelType: 'SEARCH',
            campaignBudget: budgetResource,
            containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
            manualCpc: {},
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const campaignResource = campaignResp?.results?.[0]?.resourceName || campaignResp?.results?.[0]?.campaign?.resourceName;
        if (!campaignResource) throw new Error(`Campaign created but no resource name returned: ${JSON.stringify(campaignResp)}`);

        const adGroupResp = await googleAdsFetch(`/customers/${cid}/adGroups:mutate`, {
          operations: [{ create: { name: args.ad_group_name, campaign: campaignResource, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: micros(args.default_cpc_bid) } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });
        const adGroupResource = adGroupResp?.results?.[0]?.resourceName || adGroupResp?.results?.[0]?.adGroup?.resourceName;
        if (!adGroupResource) throw new Error(`Ad group created but no resource name returned: ${JSON.stringify(adGroupResp)}`);

        await googleAdsFetch(`/customers/${cid}/adGroupCriteria:mutate`, {
          operations: args.keywords.map((k) => ({ create: { adGroup: adGroupResource, status: 'ENABLED', keyword: { text: k.text, matchType: k.match_type } } })),
          partialFailure: true,
        });

        const adResp = await googleAdsFetch(`/customers/${cid}/adGroupAds:mutate`, {
          operations: [{ create: {
            adGroup: adGroupResource,
            status: 'ENABLED',
            ad: {
              finalUrls: [args.final_url],
              responsiveSearchAd: {
                headlines: args.headlines.map((text) => ({ text })),
                descriptions: args.descriptions.map((text) => ({ text })),
              },
            },
          } }],
          responseContentType: 'MUTABLE_RESOURCE',
        });

        return textResult({
          safety: 'Campaign created PAUSED. It will not serve until google_ads_set_campaign_status is called with ENABLED.',
          budget: budgetResp,
          campaign: campaignResp,
          ad_group: adGroupResp,
          ad: adResp,
        });
      } catch (e) { return errorResult(e); }
    });

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
    });
  },
  { name: 'Pure Majesty Google Ads + GA4', version: '1.3.0' },
  { basePath: '/api' },
);

const verifyToken = async (_request, bearerToken) => {
  if (!bearerToken) return undefined;
  try {
    const payload = verifySignedToken(bearerToken, 'access');
    const scopes = String(payload.scope || '')
      .split(/\s+/)
      .filter((scope) => MCP_SCOPES.includes(scope));
    if (!payload.client_id || !scopes.length) return undefined;
    return {
      token: bearerToken,
      scopes,
      clientId: String(payload.client_id),
      extra: {
        subject: payload.sub || 'pure-majesty-owner',
        audience: payload.aud || null,
      },
    };
  } catch {
    return undefined;
  }
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: MCP_SCOPES,
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
