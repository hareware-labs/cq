class Cq < Formula
  desc "Task queue supervisor for Claude Code that parks on rate limits"
  homepage "https://github.com/hareware-labs/cq"
  url "https://github.com/hareware-labs/cq/archive/refs/tags/v0.1.0.tar.gz"
  # PLACEHOLDER: no v0.1.0 tag exists yet. The release script fills this in at
  # release time per docs/RELEASING.md step 4 (download the real archive and
  # `shasum -a 256` it) — do not invent a value here.
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
