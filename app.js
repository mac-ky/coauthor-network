(function () {
  "use strict";

  var MAX_PAPERS = 1000;
  var MAX_COAUTHORS = 90;
  var MAX_CLUSTERS = 3;
  var RETRY_DELAYS = [1200, 2500, 5000, 9000];

  // ---------------------------------------------------------------
  // Generic fetch with retry/backoff on 429 / network errors
  // ---------------------------------------------------------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function fetchJsonRetry(url) {
    var lastErr = null;
    var delays = [0].concat(RETRY_DELAYS);
    for (var i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      try {
        var resp = await fetch(url, { headers: { "Accept": "application/json" } });
      } catch (err) {
        lastErr = { rateLimited: false, message: err.message };
        continue;
      }
      if (resp.status === 429) { lastErr = { rateLimited: true }; continue; }
      if (!resp.ok) { lastErr = { rateLimited: false, message: "HTTP " + resp.status }; continue; }
      return await resp.json();
    }
    throw lastErr || { rateLimited: false, message: "unknown_error" };
  }

  // ---------------------------------------------------------------
  // Data source adapters — each returns a unified shape:
  //   search(name) -> [{ id, name, affiliation, extra }]
  //   fetchPapers(candidate) -> { papers: [{authors:[{id,name}, ...]}], cappedPapers }
  //   centerId(candidate) -> id used as the graph's center node id
  // ---------------------------------------------------------------
  var ADAPTERS = {
    cinii: {
      label: "CiNii Research",
      hint: "日本語の学会発表・紀要論文にも対応しています。海外の国際会議論文などは収録が薄い場合があります。共著者ごとの一意なIDはないため、氏名の表記に基づいて集計します。",
      placeholder: "著者名を入力（例：田部井優也）",
      async search(name) {
        var url = "https://cir.nii.ac.jp/opensearch/v2/researchers?name=" + encodeURIComponent(name) + "&format=json&count=20";
        var data = await fetchJsonRetry(url);
        var items = data.items || [];
        return items.map(function (it) {
          var idUrl = (it["@id"] || "");
          var crid = idUrl.split("/").filter(Boolean).pop();
          return {
            source: "cinii",
            rawId: crid,
            id: it.title,
            name: it.title,
            affiliation: it.description || "",
            extra: null
          };
        });
      },
      centerId: function (candidate) { return candidate.name; },
      async fetchPapers(candidate) {
        var papers = [];
        var start = 1, count = 200, total = Infinity;
        while (start <= total && papers.length < MAX_PAPERS) {
          var url = "https://cir.nii.ac.jp/opensearch/articles?researcherId=" + encodeURIComponent(candidate.rawId) +
            "&format=json&count=" + count + "&start=" + start;
          var data = await fetchJsonRetry(url);
          total = data["opensearch:totalResults"] || 0;
          var items = data.items || [];
          if (items.length === 0) break;
          items.forEach(function (it) {
            var creators = it["dc:creator"];
            var names = Array.isArray(creators) ? creators : (creators ? [creators] : []);
            papers.push({ authors: names.map(function (n) { return { id: n, name: n }; }) });
          });
          start += count;
        }
        return { papers: papers, cappedPapers: papers.length >= MAX_PAPERS || papers.length < total };
      }
    },

    s2: {
      label: "Semantic Scholar",
      hint: "英語論文・国際会議中心の無料学術データベースです。日本語のみの学会発表・紀要はカバーされないことがあります。",
      placeholder: "著者名を入力（例：Yuya Tabei）",
      async search(name) {
        var url = "https://api.semanticscholar.org/graph/v1/author/search?query=" + encodeURIComponent(name) +
          "&fields=name,affiliations,paperCount,citationCount,hIndex";
        var data = await fetchJsonRetry(url);
        var items = data.data || [];
        items.sort(function (a, b) { return (b.paperCount || 0) - (a.paperCount || 0); });
        return items.map(function (a) {
          return {
            source: "s2",
            rawId: a.authorId,
            id: a.authorId,
            name: a.name,
            affiliation: (a.affiliations && a.affiliations.length) ? a.affiliations.join(", ") : "",
            extra: { paperCount: a.paperCount || 0, citationCount: a.citationCount || 0, hIndex: a.hIndex || 0 }
          };
        });
      },
      centerId: function (candidate) { return candidate.id; },
      async fetchPapers(candidate) {
        var papers = [];
        var offset = 0, limit = 1000;
        while (papers.length < MAX_PAPERS) {
          var url = "https://api.semanticscholar.org/graph/v1/author/" + encodeURIComponent(candidate.id) +
            "/papers?fields=title,year,authors&limit=" + limit + "&offset=" + offset;
          var data = await fetchJsonRetry(url);
          var items = data.data || [];
          items.forEach(function (p) {
            var authors = (p.authors || []).filter(function (a) { return a.authorId; });
            papers.push({ authors: authors.map(function (a) { return { id: a.authorId, name: a.name }; }) });
          });
          if (items.length < limit || !data.next) break;
          offset += limit;
        }
        return { papers: papers.slice(0, MAX_PAPERS), cappedPapers: papers.length >= MAX_PAPERS };
      }
    }
  };

  // ---------------------------------------------------------------
  // Graph construction: aggregate co-authorship, then auto-cluster
  // via label propagation (a lightweight community-detection algorithm)
  // ---------------------------------------------------------------
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
  }

  function detectCommunities(nodeIds, edges) {
    if (nodeIds.length === 0) return [];
    var idSet = new Set(nodeIds);
    var adj = new Map();
    nodeIds.forEach(function (id) { adj.set(id, new Map()); });
    edges.forEach(function (e) {
      if (!idSet.has(e.a) || !idSet.has(e.b)) return;
      adj.get(e.a).set(e.b, (adj.get(e.a).get(e.b) || 0) + e.w);
      adj.get(e.b).set(e.a, (adj.get(e.b).get(e.a) || 0) + e.w);
    });
    var label = new Map();
    nodeIds.forEach(function (id, i) { label.set(id, i); });
    var order = nodeIds.slice();
    for (var iter = 0; iter < 40; iter++) {
      shuffle(order);
      var changed = false;
      order.forEach(function (id) {
        var neighbors = adj.get(id);
        if (neighbors.size === 0) return;
        var scores = new Map();
        neighbors.forEach(function (w, nbId) {
          var l = label.get(nbId);
          scores.set(l, (scores.get(l) || 0) + w);
        });
        var best = label.get(id), bestScore = -1;
        scores.forEach(function (s, l) { if (s > bestScore) { bestScore = s; best = l; } });
        if (best !== label.get(id)) { label.set(id, best); changed = true; }
      });
      if (!changed) break;
    }
    var groups = new Map();
    nodeIds.forEach(function (id) {
      var l = label.get(id);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(id);
    });
    return Array.from(groups.values()).sort(function (a, b) { return b.length - a.length; });
  }

  function buildGraph(centerId, centerName, papers) {
    var nameVotes = new Map();
    var paperCount = new Map();
    var edgeWeight = new Map();
    var validPaperCount = 0;

    papers.forEach(function (paper) {
      var ids = (paper.authors || []).map(function (a) { return a.id; }).filter(Boolean);
      if (ids.indexOf(centerId) === -1) return;
      validPaperCount++;
      paper.authors.forEach(function (a) {
        if (!a.id) return;
        if (!nameVotes.has(a.id)) nameVotes.set(a.id, new Map());
        var votes = nameVotes.get(a.id);
        votes.set(a.name, (votes.get(a.name) || 0) + 1);
        paperCount.set(a.id, (paperCount.get(a.id) || 0) + 1);
      });
      for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
          if (ids[i] === ids[j]) continue;
          var key = [ids[i], ids[j]].sort().join("␟");
          edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);
        }
      }
    });

    var resolvedName = new Map();
    nameVotes.forEach(function (votes, id) {
      var best = null, bestCount = -1;
      votes.forEach(function (c, n) { if (c > bestCount) { bestCount = c; best = n; } });
      resolvedName.set(id, best);
    });
    resolvedName.set(centerId, centerName);

    var others = Array.from(paperCount.keys()).filter(function (id) { return id !== centerId; });
    others.sort(function (a, b) { return paperCount.get(b) - paperCount.get(a); });
    var omitted = Math.max(0, others.length - MAX_COAUTHORS);
    var kept = new Set(others.slice(0, MAX_COAUTHORS));
    kept.add(centerId);

    var edges = [];
    edgeWeight.forEach(function (w, key) {
      var pair = key.split("␟");
      if (kept.has(pair[0]) && kept.has(pair[1])) edges.push({ a: pair[0], b: pair[1], w: w });
    });

    var communityNodeIds = Array.from(kept).filter(function (id) { return id !== centerId; });
    var communityEdges = edges.filter(function (e) { return e.a !== centerId && e.b !== centerId; });
    var communities = detectCommunities(communityNodeIds, communityEdges);
    var clusterOf = new Map();
    communities.forEach(function (members, idx) {
      var slot = idx < MAX_CLUSTERS ? idx : MAX_CLUSTERS;
      members.forEach(function (id) { clusterOf.set(id, slot); });
    });

    var nodes = [{ id: centerId, name: resolvedName.get(centerId) || centerName, count: validPaperCount, cluster: "center" }];
    kept.forEach(function (id) {
      if (id === centerId) return;
      nodes.push({
        id: id,
        name: resolvedName.get(id) || "?",
        count: paperCount.get(id) || 0,
        cluster: clusterOf.has(id) ? clusterOf.get(id) : MAX_CLUSTERS
      });
    });

    return {
      nodes: nodes,
      edges: edges,
      meta: {
        totalPapers: validPaperCount,
        totalCoauthors: others.length,
        shownCoauthors: kept.size - 1,
        omittedCoauthors: omitted
      }
    };
  }

  // ---------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------
  var currentSource = "cinii";

  var sourceToggle = document.getElementById("sourceToggle");
  var searchForm = document.getElementById("searchForm");
  var searchInput = document.getElementById("searchInput");
  var searchBtn = document.getElementById("searchBtn");
  var searchHint = document.getElementById("searchHint");

  var statusCard = document.getElementById("statusCard");
  var spinner = document.getElementById("spinner");
  var statusText = document.getElementById("statusText");
  var statusRow = statusCard.querySelector(".status-row");

  var candidatesCard = document.getElementById("candidatesCard");
  var candidatesList = document.getElementById("candidatesList");

  var resultSection = document.getElementById("resultSection");
  var backBtn = document.getElementById("backBtn");
  var centerLabel = document.getElementById("centerLabel");
  var sourceNotes = document.getElementById("sourceNotes");

  function applySourceUI() {
    var adapter = ADAPTERS[currentSource];
    searchInput.placeholder = adapter.placeholder;
    searchHint.textContent = adapter.hint;
    Array.prototype.forEach.call(sourceToggle.querySelectorAll(".source-btn"), function (btn) {
      var active = btn.dataset.source === currentSource;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
  }
  sourceToggle.addEventListener("click", function (evt) {
    var btn = evt.target.closest(".source-btn");
    if (!btn) return;
    currentSource = btn.dataset.source;
    applySourceUI();
  });
  applySourceUI();

  function setStatus(msg, opts) {
    opts = opts || {};
    statusCard.hidden = false;
    statusText.textContent = msg;
    spinner.hidden = !opts.loading;
    statusRow.classList.toggle("is-error", !!opts.error);
  }
  function hideStatus() { statusCard.hidden = true; }

  function resetToSearch() {
    candidatesCard.hidden = true;
    resultSection.hidden = true;
    hideStatus();
    searchInput.focus();
  }
  backBtn.addEventListener("click", resetToSearch);

  searchForm.addEventListener("submit", function (evt) {
    evt.preventDefault();
    var q = searchInput.value.trim();
    if (!q) return;
    doSearch(q);
  });

  function errMessage(err) {
    if (err && err.rateLimited) return "APIのレート制限にかかりました。しばらく待って再度お試しください。";
    if (err && err.message) return "エラーが発生しました：" + err.message;
    return "エラーが発生しました。時間をおいて再度お試しください。";
  }

  async function doSearch(query) {
    var adapter = ADAPTERS[currentSource];
    candidatesCard.hidden = true;
    resultSection.hidden = true;
    searchBtn.disabled = true;
    setStatus("「" + query + "」を " + adapter.label + " で検索しています…", { loading: true });
    try {
      var results = await adapter.search(query);
      searchBtn.disabled = false;
      if (results.length === 0) {
        setStatus("「" + query + "」に一致する著者が見つかりませんでした。表記や別のデータソースをお試しください。", { error: true });
        return;
      }
      hideStatus();
      if (results.length === 1) { selectCandidate(results[0]); return; }
      renderCandidates(results);
    } catch (err) {
      searchBtn.disabled = false;
      setStatus(errMessage(err), { error: true });
    }
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function renderCandidates(results) {
    candidatesList.innerHTML = "";
    results.forEach(function (c) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "candidate";
      var statsHtml = "";
      if (c.extra) {
        statsHtml =
          "<div class='cand-stats'>" +
          "<span><b>" + c.extra.paperCount + "</b> 論文</span>" +
          "<span><b>" + c.extra.citationCount + "</b> 被引用</span>" +
          "<span><b>h" + c.extra.hIndex + "</b></span>" +
          "</div>";
      }
      btn.innerHTML =
        "<div><div class='cand-name'>" + escapeHtml(c.name) + "</div>" +
        "<div class='cand-aff'>" + escapeHtml(c.affiliation || "所属情報なし") + "</div></div>" +
        statsHtml;
      btn.addEventListener("click", function () { selectCandidate(c); });
      candidatesList.appendChild(btn);
    });
    candidatesCard.hidden = false;
  }

  async function selectCandidate(candidate) {
    var adapter = ADAPTERS[candidate.source];
    candidatesCard.hidden = true;
    resultSection.hidden = true;
    setStatus(escapeHtml(candidate.name) + " の論文・共著データを取得しています（論文数が多い場合は時間がかかることがあります）…", { loading: true });
    try {
      var result = await adapter.fetchPapers(candidate);
      var centerId = adapter.centerId(candidate);
      var graph = buildGraph(centerId, candidate.name, result.papers);
      graph.meta.cappedPapers = result.cappedPapers;
      hideStatus();
      renderNetwork(candidate, graph);
    } catch (err) {
      setStatus(errMessage(err), { error: true });
    }
  }

  // ---------------------------------------------------------------
  // Graph rendering (force-directed layout, drag / pan / zoom / hover)
  // ---------------------------------------------------------------
  function renderNetwork(candidate, data) {
    var nodesData = data.nodes || [];
    var edgesData = data.edges || [];
    var meta = data.meta || {};
    var CENTER = ADAPTERS[candidate.source].centerId(candidate);

    centerLabel.innerHTML = "中心著者：<b>" + escapeHtml(candidate.name) + "</b>（" + ADAPTERS[candidate.source].label + "）";

    sourceNotes.innerHTML = "<li>データ出典は " + escapeHtml(ADAPTERS[candidate.source].label) + " です。" + escapeHtml(ADAPTERS[candidate.source].hint) + "</li>";

    var W = 1000, H = 720, CX = W / 2, CY = H / 2;
    var maxCount = 1;
    nodesData.forEach(function (n) { if (n.id !== CENTER) maxCount = Math.max(maxCount, n.count); });
    var maxWeight = 1;
    edgesData.forEach(function (e) { maxWeight = Math.max(maxWeight, e.w); });

    function radiusFor(n) { return n.id === CENTER ? 30 : 8 + 20 * Math.sqrt(n.count / maxCount); }
    function widthFor(w) { return 1 + 5 * Math.sqrt(w / maxWeight); }
    function opacityFor(w) { return 0.28 + 0.55 * (w / maxWeight); }

    var nodes = nodesData.map(function (n, i) {
      var angle = (i / nodesData.length) * Math.PI * 2;
      var rr = n.id === CENTER ? 0 : 220 + (Math.random() - 0.5) * 60;
      return {
        id: n.id, name: n.name, cluster: n.id === CENTER ? "center" : n.cluster,
        count: n.count, r: radiusFor(n),
        x: CX + Math.cos(angle) * rr, y: CY + Math.sin(angle) * rr, vx: 0, vy: 0
      };
    });
    var nodeById = {};
    nodes.forEach(function (n) { nodeById[n.id] = n; });

    var edges = edgesData.filter(function (e) { return nodeById[e.a] && nodeById[e.b]; });

    var K_REP = 26000, K_SPRING = 0.02, K_CENTER = 0.0012, DAMPING = 0.82;
    function idealLen(w) { return 150 / (1 + w * 0.4); }

    var iterations = nodes.length > 60 ? 320 : 480;
    for (var iter = 0; iter < iterations; iter++) {
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var n1 = nodes[i], n2 = nodes[j];
          var dx = n1.x - n2.x, dy = n1.y - n2.y;
          var dist2 = dx * dx + dy * dy; if (dist2 < 1) dist2 = 1;
          var dist = Math.sqrt(dist2);
          var force = K_REP / dist2;
          var fx = (dx / dist) * force, fy = (dy / dist) * force;
          n1.vx += fx; n1.vy += fy; n2.vx -= fx; n2.vy -= fy;
        }
      }
      edges.forEach(function (e) {
        var n1 = nodeById[e.a], n2 = nodeById[e.b];
        var dx = n2.x - n1.x, dy = n2.y - n1.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var target = idealLen(e.w);
        var force = K_SPRING * (dist - target);
        var fx = (dx / dist) * force, fy = (dy / dist) * force;
        n1.vx += fx; n1.vy += fy; n2.vx -= fx; n2.vy -= fy;
      });
      nodes.forEach(function (n) {
        n.vx += (CX - n.x) * K_CENTER; n.vy += (CY - n.y) * K_CENTER;
        n.vx *= DAMPING; n.vy *= DAMPING; n.x += n.vx; n.y += n.vy;
      });
    }
    for (var pass = 0; pass < 60; pass++) {
      for (var a = 0; a < nodes.length; a++) {
        for (var b = a + 1; b < nodes.length; b++) {
          var na = nodes[a], nb = nodes[b];
          var ddx = nb.x - na.x, ddy = nb.y - na.y;
          var d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
          var minD = na.r + nb.r + 14;
          if (d < minD) {
            var push = (minD - d) / 2;
            var ux = ddx / d, uy = ddy / d;
            na.x -= ux * push; na.y -= uy * push;
            nb.x += ux * push; nb.y += uy * push;
          }
        }
      }
    }
    nodes.forEach(function (n) {
      var m = n.r + 16;
      n.x = Math.min(W - m, Math.max(m, n.x));
      n.y = Math.min(H - m, Math.max(m, n.y));
    });

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.getElementById("graph");
    var edgesLayer = document.getElementById("edgesLayer");
    var nodesLayer = document.getElementById("nodesLayer");
    edgesLayer.innerHTML = "";
    nodesLayer.innerHTML = "";

    function clusterColorVar(c) {
      if (c === 0) return "var(--c-1)";
      if (c === 1) return "var(--c-2)";
      if (c === 2) return "var(--c-3)";
      return "var(--c-other)";
    }
    var clusterLabelText = { 0: "共著グループ A", 1: "共著グループ B", 2: "共著グループ C" };

    var edgeEls = edges.map(function (e) {
      var n1 = nodeById[e.a], n2 = nodeById[e.b];
      var line = document.createElementNS(svgNS, "line");
      line.setAttribute("class", "edge");
      line.setAttribute("x1", n1.x); line.setAttribute("y1", n1.y);
      line.setAttribute("x2", n2.x); line.setAttribute("y2", n2.y);
      line.setAttribute("stroke-width", widthFor(e.w));
      line.setAttribute("stroke-opacity", opacityFor(e.w));
      edgesLayer.appendChild(line);
      return { el: line, a: e.a, b: e.b, baseOpacity: opacityFor(e.w) };
    });

    var nodeEls = nodes.map(function (n) {
      var g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "node" + (n.id === CENTER ? " center" : (n.count >= Math.max(3, maxCount * 0.4) ? " hub" : "")));
      g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");

      var circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("r", n.r);
      if (n.id !== CENTER) circle.setAttribute("fill", clusterColorVar(n.cluster));
      g.appendChild(circle);

      var text = document.createElementNS(svgNS, "text");
      text.setAttribute("class", "name");
      text.setAttribute("y", n.r + 12);
      text.textContent = n.name;
      g.appendChild(text);

      nodesLayer.appendChild(g);
      return { el: g, id: n.id, node: n };
    });

    var neighbors = {};
    nodes.forEach(function (n) { neighbors[n.id] = new Set(); });
    edges.forEach(function (e) { neighbors[e.a].add(e.b); neighbors[e.b].add(e.a); });

    var pinned = null;
    function clearHighlight() {
      edgeEls.forEach(function (e) { e.el.setAttribute("stroke-opacity", e.baseOpacity); e.el.setAttribute("stroke", "var(--muted)"); });
      nodeEls.forEach(function (n) { n.el.style.opacity = 1; });
    }
    function applyHighlight(id) {
      var keep = neighbors[id]; keep.add(id);
      edgeEls.forEach(function (e) {
        var active = e.a === id || e.b === id;
        e.el.setAttribute("stroke-opacity", active ? Math.min(1, e.baseOpacity + 0.35) : 0.05);
        e.el.setAttribute("stroke", active ? "var(--ink)" : "var(--muted)");
      });
      nodeEls.forEach(function (n) { n.el.style.opacity = keep.has(n.id) ? 1 : 0.22; });
    }

    var tooltip = document.getElementById("tooltip");
    var graphWrap = document.getElementById("graphWrap");
    function showTooltip(n, evt) {
      var wrapRect = graphWrap.getBoundingClientRect();
      var lbl;
      if (n.id === CENTER) {
        lbl = "<b>" + escapeHtml(n.name) + "</b><br>全" + n.count + "編（中心著者）";
      } else {
        var grp = clusterLabelText[n.cluster] || "その他";
        lbl = "<b>" + escapeHtml(n.name) + "</b><br><span class='tt-cluster'>" + grp + "</span><br>共著論文：" + n.count + "編";
      }
      tooltip.innerHTML = lbl;
      tooltip.hidden = false;
      tooltip.style.left = (evt.clientX - wrapRect.left) + "px";
      tooltip.style.top = (evt.clientY - wrapRect.top) + "px";
    }
    function hideTooltip() { tooltip.hidden = true; }

    var view = { x: 0, y: 0, w: W, h: H };
    function applyView() { svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h); }
    function svgPoint(evt) {
      var pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }

    var draggingNode = null, panState = null;

    nodeEls.forEach(function (ne) {
      ne.el.addEventListener("pointerenter", function (evt) { if (!pinned) applyHighlight(ne.id); showTooltip(ne.node, evt); });
      ne.el.addEventListener("pointermove", function (evt) { showTooltip(ne.node, evt); });
      ne.el.addEventListener("pointerleave", function () { if (!pinned) clearHighlight(); hideTooltip(); });
      ne.el.addEventListener("pointerdown", function (evt) { evt.stopPropagation(); draggingNode = ne; ne.el.setPointerCapture(evt.pointerId); });
      ne.el.addEventListener("click", function (evt) {
        evt.stopPropagation();
        if (pinned === ne.id) { pinned = null; clearHighlight(); }
        else { pinned = ne.id; applyHighlight(ne.id); }
      });
    });

    svg.addEventListener("pointermove", function (evt) {
      if (!draggingNode) return;
      var p = svgPoint(evt);
      var n = draggingNode.node;
      n.x = p.x; n.y = p.y;
      draggingNode.el.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
      edgeEls.forEach(function (e) {
        if (e.a === n.id) { e.el.setAttribute("x1", n.x); e.el.setAttribute("y1", n.y); }
        else if (e.b === n.id) { e.el.setAttribute("x2", n.x); e.el.setAttribute("y2", n.y); }
      });
    });
    window.addEventListener("pointerup", function () { draggingNode = null; });

    svg.addEventListener("pointerdown", function (evt) {
      if (draggingNode) return;
      panState = { startX: evt.clientX, startY: evt.clientY, viewX: view.x, viewY: view.y };
      svg.classList.add("panning");
      if (pinned) { pinned = null; clearHighlight(); }
    });
    svg.addEventListener("pointermove", function (evt) {
      if (!panState) return;
      var scale = view.w / svg.getBoundingClientRect().width;
      view.x = panState.viewX - (evt.clientX - panState.startX) * scale;
      view.y = panState.viewY - (evt.clientY - panState.startY) * scale;
      applyView();
    });
    window.addEventListener("pointerup", function () { panState = null; svg.classList.remove("panning"); });

    svg.addEventListener("wheel", function (evt) {
      evt.preventDefault();
      var rect = svg.getBoundingClientRect();
      var mx = view.x + (evt.clientX - rect.left) * (view.w / rect.width);
      var my = view.y + (evt.clientY - rect.top) * (view.h / rect.height);
      var scale = evt.deltaY > 0 ? 1.1 : 0.9;
      var newW = Math.min(W * 2.2, Math.max(W * 0.35, view.w * scale));
      var newH = newW * (H / W);
      view.x = mx - (mx - view.x) * (newW / view.w);
      view.y = my - (my - view.y) * (newH / view.h);
      view.w = newW; view.h = newH;
      applyView();
    }, { passive: false });

    document.getElementById("resetView").onclick = function () {
      view = { x: 0, y: 0, w: W, h: H };
      applyView();
      pinned = null; clearHighlight(); hideTooltip();
    };
    applyView();

    // ---- legend ----
    var presentClusters = new Set();
    nodesData.forEach(function (n) { if (n.id !== CENTER) presentClusters.add(n.cluster); });
    var legend = document.getElementById("legend");
    var html = "<div class='legend-item'><span class='swatch center'></span>" + escapeHtml(candidate.name) + "（中心）</div>";
    [0, 1, 2].forEach(function (c) {
      if (presentClusters.has(c)) {
        html += "<div class='legend-item'><span class='swatch' style='background:" + clusterColorVar(c) + "'></span>" + clusterLabelText[c] + "</div>";
      }
    });
    if (presentClusters.has(3)) {
      html += "<div class='legend-item'><span class='swatch' style='background:var(--c-other)'></span>その他（小規模グループ）</div>";
    }
    legend.innerHTML = html;

    // ---- stats ----
    var statsRow = document.getElementById("statsRow");
    statsRow.innerHTML = "";
    [
      [String(meta.totalPapers || 0), "取得論文数"],
      [String(meta.shownCoauthors != null ? meta.shownCoauthors : (nodesData.length - 1)), "表示中の共著者数"],
      [String(meta.totalCoauthors || 0), "延べ共著者数"],
      [String(edges.length), "共著者間の関係数"]
    ].forEach(function (pair) {
      var div = document.createElement("div");
      div.className = "stat";
      div.innerHTML = "<div class='v'>" + escapeHtml(pair[0]) + "</div><div class='l'>" + pair[1] + "</div>";
      statsRow.appendChild(div);
    });

    var metaNote = document.getElementById("metaNote");
    var notes = [];
    if (meta.omittedCoauthors) notes.push("共著論文数の少ない共著者 " + meta.omittedCoauthors + " 名は図から省略しています。");
    if (meta.cappedPapers) notes.push("論文取得件数を上限（" + MAX_PAPERS + "件程度）で打ち切っている可能性があります。");
    metaNote.textContent = notes.join(" ");

    // ---- table ----
    var tbody = document.getElementById("tableBody");
    tbody.innerHTML = "";
    var rows = nodesData.filter(function (n) { return n.id !== CENTER; })
      .sort(function (x, y) { return y.count - x.count; });
    rows.forEach(function (n, i) {
      var tr = document.createElement("tr");
      var swatch = n.cluster === 3 ? "var(--c-other)" : clusterColorVar(n.cluster);
      var label = n.cluster === 3 ? "その他" : (clusterLabelText[n.cluster] || "その他");
      tr.innerHTML =
        "<td class='num'>" + (i + 1) + "</td>" +
        "<td>" + escapeHtml(n.name) + "</td>" +
        "<td><span class='cluster-tag'><span class='swatch' style='background:" + swatch + "'></span>" + label + "</span></td>" +
        "<td class='num'>" + n.count + "</td>";
      tbody.appendChild(tr);
    });

    resultSection.hidden = false;
  }
})();
