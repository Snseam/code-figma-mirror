Page({
  data: { title: '叶片观察', expanded: false },
  toggle() {
    this.setData({ expanded: !this.data.expanded });
  }
});
