class Cq < Formula
  desc "Task queue supervisor for Claude Code that parks on rate limits"
  homepage "https://github.com/hareware-labs/cq"
  url "https://github.com/hareware-labs/cq/archive/refs/tags/v0.1.0.tar.gz"
  # All zeros until `node scripts/release.mjs X.Y.Z --formula` hashes the pushed
  # tag's archive (docs/RELEASING.md §7). Never invent a value here.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cq --version")
  end
end
