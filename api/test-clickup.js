const https = require("https");

function clickupGet(token, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.clickup.com",
      port: 443,
      path: "/api/v2" + path,
      method: "GET",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.substring(0, 500) }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = async (req, res) => {
  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID || "901307458702";

  if (!token) {
    return res.status(200).json({ error: "CLICKUP_API_TOKEN not set" });
  }

  const tokenInfo = {
    prefix: token.substring(0, 8) + "...",
    length: token.length,
    startsWithPk: token.startsWith("pk_")
  };

  try {
    // Test 1: Get user (auth check)
    const userResult = await clickupGet(token, "/user");

    // Test 2: Get list info (list access check)
    const listResult = await clickupGet(token, "/list/" + listId);

    // Test 3: Get teams/workspaces
    const teamsResult = await clickupGet(token, "/team");

    res.status(200).json({
      tokenInfo,
      listId,
      tests: {
        user: userResult,
        list: listResult,
        teams: teamsResult
      }
    });
  } catch(err) {
    res.status(200).json({ tokenInfo, error: err.message });
  }
};
