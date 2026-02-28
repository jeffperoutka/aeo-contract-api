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

  if (!token) {
    return res.status(200).json({ error: "CLICKUP_API_TOKEN not set" });
  }

  try {
    // Get teams/workspaces
    const teamsResult = await clickupGet(token, "/team");
    const teams = teamsResult.data.teams || [];

    const results = [];

    for (const team of teams) {
      const teamInfo = { id: team.id, name: team.name, spaces: [] };

      // Get spaces in this team
      const spacesResult = await clickupGet(token, "/team/" + team.id + "/space?archived=false");
      const spaces = spacesResult.data.spaces || [];

      for (const space of spaces) {
        const spaceInfo = { id: space.id, name: space.name, folders: [], folderlessLists: [] };

        // Get folders in this space
        const foldersResult = await clickupGet(token, "/space/" + space.id + "/folder?archived=false");
        const folders = foldersResult.data.folders || [];

        for (const folder of folders) {
          const folderInfo = { id: folder.id, name: folder.name, lists: [] };
          // Folders contain lists
          if (folder.lists) {
            for (const list of folder.lists) {
              folderInfo.lists.push({ id: list.id, name: list.name });
            }
          }
          spaceInfo.folders.push(folderInfo);
        }

        // Get folderless lists
        const listsResult = await clickupGet(token, "/space/" + space.id + "/list?archived=false");
        const lists = listsResult.data.lists || [];
        for (const list of lists) {
          spaceInfo.folderlessLists.push({ id: list.id, name: list.name });
        }

        teamInfo.spaces.push(spaceInfo);
      }
      results.push(teamInfo);
    }

    res.status(200).json({
      configuredListId: process.env.CLICKUP_LIST_ID || "901307458702",
      workspace: results
    });
  } catch(err) {
    res.status(200).json({ error: err.message });
  }
};
