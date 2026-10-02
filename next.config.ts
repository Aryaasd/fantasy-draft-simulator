import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next writes AGENTS.md / CLAUDE.md on dev start. Useful locally, noise in a
  // public repo.
  agentRules: false,
};

export default nextConfig;
