{
  "targets": [
    {
      "target_name": "wasapi_latency",
      "sources": ["wasapi_latency.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1
            }
          },
          "link_settings": {
            "libraries": ["-lole32.lib", "-lpropsys.lib"]
          },
          "defines": ["UNICODE", "_UNICODE"]
        }]
      ]
    }
  ]
}
