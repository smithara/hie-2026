// Client-side poster search + topic filter. No dependencies.
(function () {
  "use strict";

  var grid = document.getElementById("poster-grid");
  if (!grid) return;

  var search = document.getElementById("poster-search");
  var topic = document.getElementById("poster-topic");
  var count = document.getElementById("gallery-count");
  var noResults = document.getElementById("no-results");
  var cards = Array.prototype.slice.call(grid.querySelectorAll(".poster-card"));
  var total = cards.length;

  function normalize(s) {
    return (s || "").toLowerCase().trim();
  }

  function apply() {
    var q = normalize(search && search.value);
    var t = topic ? topic.value : "";
    var shown = 0;

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var matchText = !q || card.dataset.search.indexOf(q) !== -1;
      var matchTopic = !t || card.dataset.topic === t;
      var visible = matchText && matchTopic;
      card.hidden = !visible;
      if (visible) shown++;
    }

    if (count) {
      count.textContent =
        shown === total ? total + " posters" : shown + " of " + total;
    }
    if (noResults) noResults.hidden = shown !== 0;
  }

  // Debounce the search input a touch for large galleries.
  var timer;
  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(apply, 90);
  }

  if (search) search.addEventListener("input", onInput);
  if (topic) topic.addEventListener("change", apply);

  apply();
})();
