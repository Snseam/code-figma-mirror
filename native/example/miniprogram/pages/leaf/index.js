Page({
  onLoad() {
    const pages = getCurrentPages();
    const parent = pages[pages.length - 2];
    if (parent && parent.data.mirrorFontFamily) {
      this.setData({ mirrorFontFamily: parent.data.mirrorFontFamily });
    }
  }
});
