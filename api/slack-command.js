/**
 * AEO Labs — Slack Slash Command Handler
 *
 * Handles /new-contract slash command by opening a modal form.
 * Slack sends a POST with application/x-www-form-urlencoded body
 * containing trigger_id which we use to open the modal.
 *
 * POST /api/slack-command
 */

const https = require("https");

function slackAPI(method, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: "slack.com",
      port: 443,
      path: "/api/" + method,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false, error: "parse_error", raw: data.substring(0, 500) }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function buildContractModal() {
  return {
    type: "modal",
    callback_id: "new_contract_submit",
    title: {
      type: "plain_text",
      text: "New Contract"
    },
    submit: {
      type: "plain_text",
      text: "Generate Contract"
    },
    close: {
      type: "plain_text",
      text: "Cancel"
    },
    blocks: [
      {
        type: "input",
        block_id: "contract_type",
        label: { type: "plain_text", text: "Contract Type" },
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Select contract type" },
          options: [
            {
              text: { type: "plain_text", text: "Sprint 1" },
              value: "sprint1"
            },
            {
              text: { type: "plain_text", text: "Phase 2" },
              value: "phase2"
            }
          ]
        }
      },
      {
        type: "input",
        block_id: "client_company",
        label: { type: "plain_text", text: "Company Name" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "e.g. Acme Corp" }
        }
      },
      {
        type: "input",
        block_id: "client_first",
        label: { type: "plain_text", text: "Client First Name" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "e.g. John" }
        }
      },
      {
        type: "input",
        block_id: "client_last",
        label: { type: "plain_text", text: "Client Last Name" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "e.g. Doe" }
        }
      },
      {
        type: "input",
        block_id: "client_title",
        label: { type: "plain_text", text: "Client Title" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "e.g. CEO, VP Marketing" }
        }
      },
      {
        type: "input",
        block_id: "client_email",
        label: { type: "plain_text", text: "Client Email" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "e.g. john@acme.com" }
        }
      },
      {
        type: "input",
        block_id: "amount",
        label: { type: "plain_text", text: "Contract Amount ($)" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "e.g. 5000" }
        }
      },
      {
        type: "input",
        block_id: "scope",
        label: { type: "plain_text", text: "Scope of Work" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: { type: "plain_text", text: "e.g. SEO authority link building - 10 links/month" }
        }
      }
    ]
  };
}

module.exports = async (req, res) => {
  console.log("SLACK-CMD: Received slash command");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Error: SLACK_BOT_TOKEN not configured. Contact admin."
    });
  }

  // Slack sends form-urlencoded data for slash commands
  const triggerId = req.body.trigger_id;
  const userId = req.body.user_id;
  const userName = req.body.user_name;

  console.log("SLACK-CMD: trigger_id=" + triggerId + " user=" + userName);

  if (!triggerId) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Error: No trigger_id received. Please try again."
    });
  }

  // Must respond within 3 seconds, so open modal immediately
  try {
    const result = await slackAPI("views.open", {
      trigger_id: triggerId,
      view: buildContractModal()
    }, token);

    console.log("SLACK-CMD: views.open result ok=" + result.ok);

    if (!result.ok) {
      console.error("SLACK-CMD: views.open error:", result.error);
      return res.status(200).json({
        response_type: "ephemeral",
        text: "Error opening form: " + (result.error || "unknown error")
      });
    }

    // Return empty 200 to acknowledge the slash command
    return res.status(200).send("");

  } catch (err) {
    console.error("SLACK-CMD: Error:", err.message);
    return res.status(200).json({
      response_type: "ephemeral",
      text: "Error: " + err.message
    });
  }
};
