{pkgs, ...}: {
  # https://devenv.sh/packages/
  packages = with pkgs; [
    pkg-config
  ];

  languages.typescript.enable = true;

  languages.javascript = {
    enable = true;
    corepack.enable = true;

    yarn = {
      enable = true;
      install.enable = true;
    };
  };

  dotenv.enable = true;

  # https://devenv.sh/scripts/
  scripts.monkeyhi.exec = ''echo "🙊 Let's try not to break something today!!!"'';

  enterShell = ''
    monkeyhi
  '';

  # https://devenv.sh/tests/
  enterTest = ''
    echo "Running tests"
    wait_for_port 6379

    redis-cli -p 6379 ping | grep PONG
  '';

  services.redis = {
    enable = true;
    port = 6379;
  };
}
