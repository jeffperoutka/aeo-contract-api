/**
 * AEO Labs — Slack Workflow Builder → Contract Pipeline Bridge
 *
 * Receives webhook from Slack Workflow Builder form submission,
 * validates all fields, calls the main pipeline, and posts
 * results back to #contracts-invoices channel.
 *
 * POST /api/slack-contract
 * Body (from Slack Workflow Builder webhook step):
 * {
 *   contract_type: "Sprint 1" | "Phase 2",
 *   client_company: "Acme Corp",
 *   client_first: "John",
 *   client_last: "Doe",
 *   client_title: "CEO",
 *   client_email: "john@acme.com",
 *   amount: "5000",
 *   scope: "SEO authority link building - 10 links/month"
 * }
 */

const https = require("https");

// Slack channel for posting results
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || "C0AHK69NL8K"; // #contracts-invoices

// ==================== HELPERS ====================

function postJSON(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      port: 443,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.substring(0, 1000) }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function postToSlack(token, channel, text, blocks) {
  const body = { channel, text };
  if (blocks) body.blocks = blocks;
  return postJSON("slack.com", "/api/chat.postMessage", body, {
    "Authorization": "Bearer " + token
  });
}

// ==================== FIELD VALIDATION ====================

function validateFields(body) {
  const errors = [];

  // Required fields with friendly names
  const required = {
    contract_type: "Contract Type",
    client_company: "Company Name",
    client_first: "First Name",
    client_last: "Last Name",
    client_title: "Title",
    client_email: "Email",
    amount: "Amount",
    scope: "Scope of Work"
  };

  for (const [field, label] of Object.entries(required)) {
    const val = body[field];
    if (!val || (typeof val === "string" && val.trim() === "")) {
      errors.push(`*${label}* is missing`);
    }
  }

  // Validate email format
  if (body.client_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.client_email.trim())) {
    errors.push(`*Email* "${body.client_email}" doesn't look like a valid email`);
  }

  // Validate amount is numeric
  if (body.amount) {
    const cleanAmount = String(body.amount).replace(/[$,\s]/g, "");
    if (isNaN(cleanAmount) || parseFloat(cleanAmount) <= 0) {
      errors.push(`*Amount* "${body.amount}" must be a positive number`);
    }
  }

  // Validate contract type
  if (body.contract_type) {
    const normalized = normalizeContractType(body.contract_type);
    if (!normalized) {
      errors.push(`*Contract Type* "${body.contract_type}" must be "Sprint 1" or "Phase 2"`);
    }
  }

  return errors;
}

function normalizeContractType(raw) {
  const lower = String(raw).toLowerCase().trim();
  if (lower === "sprint 1" || lower === "sprint1" || lower === "s1") return "sprint1";
  if (lower === "phase 2" || lower === "phase2" || lower === "p2") return "phase2";
  return null;
}

// ==================== SLACK MESSAGE FORMATTING ====================

function buildSuccessBlocks(result, body) {
  const amount = parseInt(String(body.amount).replace(/[$,\s]/g, "")) || 0;

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "New Contract Created",
        emoji: true
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Client:*\n${body.client_first} ${body.client_last}` },
        { type: "mrkdwn", text: `*Company:*\n${body.client_company}` },
        { type: "mrkdwn", text: `*Type:*\n${body.contract_type}` },
        { type: "mrkdwn", text: `*Amount:*\n$${amount.toLocaleString()}` }
      ]
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Email:*\n${body.client_email}` },
        { type: "mrkdwn", text: `*Title:*\n${body.client_title}` }
      ]
    },
    {
      type: "divider"
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Pipeline Results:*"
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          result.document_id ? `:white_check_mark: *Contract* generated — <https://app.signnow.com/webapp/document/${result.document_id}|View & Send Contract>` : `:x: *Contract* generation failed`,
          result.stripe && !result.stripe.error
            ? `:white_check_mark: *Stripe Invoice* created — <${result.stripe.invoiceUrl}|View Invoice>`
            : `:x: *Stripe Invoice* failed${result.stripe && result.stripe.error ? ": " + result.stripe.error : ""}`,
          result.clickup && result.clickup.id
            ? `:white_check_mark: *ClickUp Task* created — <${result.clickup.url}|View Task>`
            : `:x: *ClickUp Task* failed${result.clickup && result.clickup.error ? ": " + result.clickup.error : ""}`
        ].join("\n")
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Scope: ${body.scope || "N/A"}`
        }
      ]
    }
  ];
}

function buildErrorBlocks(errors, body) {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Contract Form Error",
        emoji: true
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: The contract form had validation errors:\n\n${errors.map(e => "• " + e).join("\n")}`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Submitted by: ${body.client_first || "?"} ${body.client_last || "?"} at ${body.client_company || "?"}`
        }
      ]
    }
  ];
}

// ==================== MAIN HANDLER ====================

module.exports = async (req, res) => {
  console.log("SLACK-CONTRACT: Received request, method=" + req.method);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const body = req.body || {};
  const slackToken = process.env.SLACK_BOT_TOKEN;

  console.log("SLACK-CONTRACT: Fields received:", Object.keys(body).join(", "));

  // Step 1: Validate all fields
  const errors = validateFields(body);

  if (errors.length > 0) {
    console.log("SLACK-CONTRACT: Validation failed:", errors.join("; "));

    // Post error to Slack if we have a token
    if (slackToken) {
      const errBlocks = buildErrorBlocks(errors, body);
      await postToSlack(slackToken, SLACK_CHANNEL, "Contract form had validation errors", errBlocks);
    }

    return res.status(200).json({
      success: false,
      errors: errors,
      message: "Validation failed: " + errors.join(", ")
    });
  }

  // Step 2: Normalize the data for the main pipeline
  const pipelineBody = {
    contract_type: normalizeContractType(body.contract_type),
    client_company: body.client_company.trim(),
    client_first: body.client_first.trim(),
    client_last: body.client_last.trim(),
    client_title: body.client_title.trim(),
    client_email: body.client_email.trim().toLowerCase(),
    amount: String(body.amount).replace(/[$,\s]/g, ""),
    scope: (body.scope || "").trim()
  };

  console.log("SLACK-CONTRACT: Calling main pipeline with:", JSON.stringify({
    contract_type: pipelineBody.contract_type,
    client_company: pipelineBody.client_company,
    client_email: pipelineBody.client_email,
    amount: pipelineBody.amount
  }));

  // Step 3: Call the main generate-and-send endpoint internally
  try {
    const pipelineResult = await postJSON(
      "aeo-contract-api.vercel.app",
      "/api/generate-and-send",
      pipelineBody,
      {}
    );

    console.log("SLACK-CONTRACT: Pipeline response status:", pipelineResult.status);
    const result = pipelineResult.data || {};

    // Step 4: Post results to Slack
    if (slackToken) {
      if (result.success) {
        const successBlocks = buildSuccessBlocks(result, body);
        const slackPost = await postToSlack(slackToken, SLACK_CHANNEL, "New contract created for " + body.client_company, successBlocks);
        console.log("SLACK-CONTRACT: Posted success to Slack:", slackPost.status);
      } else {
        // Pipeline returned but with an error
        const msg = `:warning: Contract pipeline error for *${body.client_company}*: ${result.message || result.error || "Unknown error"}`;
        await postToSlack(slackToken, SLACK_CHANNEL, msg);
      }
    } else {
      console.log("SLACK-CONTRACT: No SLACK_BOT_TOKEN set, skipping Slack notification");
    }

    // Return the pipeline result
    return res.status(200).json(result);

  } catch (err) {
    console.error("SLACK-CONTRACT: Pipeline call failed:", err.message);

    // Post error to Slack
    if (slackToken) {
      const msg = `:x: Contract pipeline crashed for *${body.client_company}*: ${err.message}`;
      await postToSlack(slackToken, SLACK_CHANNEL, msg);
    }

    return res.status(200).json({
      success: false,
      error: "Pipeline call failed: " + err.message
    });
  }
};
