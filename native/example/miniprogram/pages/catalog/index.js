Page({
  data: { filter: 'all' },
  toggleFilter() {
    this.setData({ filter: this.data.filter === 'all' ? 'leaves' : 'all' });
  }
});
