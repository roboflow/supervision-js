require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "SupervisionIdMask"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/joaomarcoscrs/supervision-js"
  s.license      = package["license"]
  s.authors      = "supervision-js"

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/joaomarcoscrs/supervision-js.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
  ]

  # The ID-mask fill loop is per-frame hot-path code. Debug app builds compile
  # pods with -Onone, which makes the tight pixel loops 10-30x slower and
  # masks the native builder's advantage over the JS fallback, so force
  # optimized Swift for every configuration.
  s.pod_target_xcconfig = {
    'SWIFT_OPTIMIZATION_LEVEL' => '-O',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  load 'nitrogen/generated/ios/SupervisionIdMask+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
