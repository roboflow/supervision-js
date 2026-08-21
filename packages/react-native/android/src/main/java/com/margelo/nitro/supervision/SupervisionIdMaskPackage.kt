package com.margelo.nitro.supervision

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registration entry point discovered by React Native autolinking. Nitro
 * hybrid objects are registered natively in `SupervisionIdMaskOnLoad`, so
 * this package only has to load the C++ library.
 */
class SupervisionIdMaskPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider { HashMap() }

  companion object {
    init {
      SupervisionIdMaskOnLoad.initializeNative()
    }
  }
}
