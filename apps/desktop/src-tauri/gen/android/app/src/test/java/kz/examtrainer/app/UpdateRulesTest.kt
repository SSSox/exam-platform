package kz.examtrainer.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {
  private val manifest = "https://github.com/owner/exam-platform/releases/latest/download/latest.json"
  private val prefix = "https://github.com/owner/exam-platform/releases/download/"

  @Test fun manifestAddressGivesTheReleaseFolder() {
    assertEquals(prefix, UpdateRules.assetPrefix(manifest))
    assertNull(UpdateRules.assetPrefix("http://github.com/owner/exam-platform/releases/latest/download/latest.json"))
    assertNull(UpdateRules.assetPrefix("https://example.com/owner/exam-platform/releases/latest/download/latest.json"))
    assertNull(UpdateRules.assetPrefix(""))
  }

  @Test fun onlyAStrictlyNewerVersionCounts() {
    assertTrue(UpdateRules.isNewer("0.2.0", "0.1.9"))
    assertTrue(UpdateRules.isNewer("v1.0.0", "0.99.99"))
    assertTrue(UpdateRules.isNewer("0.1.10", "0.1.9"))
    assertFalse(UpdateRules.isNewer("0.1.0", "0.1.0"))
    assertFalse(UpdateRules.isNewer("0.0.9", "0.1.0"))
    assertFalse(UpdateRules.isNewer("0.2.0-beta", "0.1.0"))
    assertFalse(UpdateRules.isNewer("0.2", "0.1.0"))
    assertFalse(UpdateRules.isNewer("0.2.0", "garbage"))
  }

  @Test fun theApkMustBeTheAnnouncedVersionAndANewerBuild() {
    assertTrue(UpdateRules.isAnnouncedBuild("0.3.0", 3_000L, 1_000L, "0.3.0"))
    assertTrue(UpdateRules.isAnnouncedBuild("0.3.0", 3_000L, 1_000L, "v0.3.0"))
    // An older signed APK under a newer tag: the code is higher than installed, but the name gives it away.
    assertFalse(UpdateRules.isAnnouncedBuild("0.2.0", 2_000L, 1_000L, "0.3.0"))
    assertFalse(UpdateRules.isAnnouncedBuild(null, 3_000L, 1_000L, "0.3.0"))
    assertFalse(UpdateRules.isAnnouncedBuild("0.3.0", 1_000L, 1_000L, "0.3.0"))
  }

  @Test fun theApkMustSitUnderTheAnnouncedTag() {
    assertTrue(UpdateRules.isAllowedAsset("${prefix}v0.2.0/exam-trainer-android.apk", prefix, "0.2.0"))
    assertFalse(UpdateRules.isAllowedAsset("${prefix}v0.1.0/exam-trainer-android.apk", prefix, "0.2.0"))
    assertFalse(UpdateRules.isAllowedAsset("${prefix}v0.2.0/../v0.1.0/exam-trainer-android.apk", prefix, "0.2.0"))
    assertFalse(UpdateRules.isAllowedAsset("${prefix}v0.2.0/exam-trainer-android.exe", prefix, "0.2.0"))
    assertFalse(UpdateRules.isAllowedAsset("https://github.com/other/repo/releases/download/v0.2.0/a.apk", prefix, "0.2.0"))
    assertFalse(UpdateRules.isAllowedAsset("${prefix}v0.2.0/exam-trainer-android.apk?x=1", prefix, "0.2.0"))
  }

  @Test fun onlyHttpsToGithubHosts() {
    assertTrue(UpdateRules.isAllowedHost("https://github.com/owner/repo/releases/download/v1.0.0/a.apk"))
    assertTrue(UpdateRules.isAllowedHost("https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x"))
    assertFalse(UpdateRules.isAllowedHost("http://github.com/owner/repo"))
    assertFalse(UpdateRules.isAllowedHost("https://github.com.evil.example/a.apk"))
    assertFalse(UpdateRules.isAllowedHost("https://user@github.com/a.apk"))
    assertFalse(UpdateRules.isAllowedHost("https://github.com:8443/a.apk"))
    assertFalse(UpdateRules.isAllowedHost("not a url"))
  }

  @Test fun hashesAreLowercaseHex() {
    assertTrue(UpdateRules.isSha256("a".repeat(64)))
    assertFalse(UpdateRules.isSha256("A".repeat(64)))
    assertFalse(UpdateRules.isSha256("a".repeat(63)))
    assertEquals("00ff10", UpdateRules.hex(byteArrayOf(0, -1, 16)))
  }

  @Test fun signersMustMatchExactly() {
    val ours = listOf(byteArrayOf(1, 2, 3))
    assertTrue(UpdateRules.sameSigners(ours, listOf(byteArrayOf(1, 2, 3))))
    assertFalse(UpdateRules.sameSigners(ours, listOf(byteArrayOf(9, 9, 9))))
    assertFalse(UpdateRules.sameSigners(ours, ours + listOf(byteArrayOf(4))))
    assertFalse(UpdateRules.sameSigners(emptyList(), emptyList()))
  }
}
