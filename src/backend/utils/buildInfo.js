// Which commit is this instance running? Render sets RENDER_GIT_COMMIT on
// git-backed services. The deploy workflows poll /health until this matches
// the SHA they shipped, so a 200 from the old instance doesn't count as a deploy.
function buildInfo(env = process.env) {
  return {
    commit: env.RENDER_GIT_COMMIT || null,
    environment: env.DEPLOY_ENV || null,
  };
}

module.exports = { buildInfo };
