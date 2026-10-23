class Cq < Formula
  desc "Task queue supervisor for Claude Code that parks on rate limits"
  homepage "https://github.com/hareware-labs/cq"
  url "https://github.com/hareware-labs/cq/archive/refs/tags/v1.0.0.tar.gz"
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
