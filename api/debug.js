module.exports = (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "v2-modified",
    mods: ["200-for-incomplete", "signnow-invite-disabled"]
  });
};