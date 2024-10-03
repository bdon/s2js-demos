import { createSignal, createEffect, onMount } from "solid-js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import maplibregl from "maplibre-gl";
import { s1, s2, geojson } from "s2js";
import { greatCircle } from "@turf/great-circle";
import { flatten } from "@turf/flatten";
import {
  TerraDraw,
  TerraDrawMapLibreGLAdapter,
  TerraDrawRectangleMode,
  TerraDrawPolygonMode,
  TerraDrawRenderMode,
} from "terra-draw";
import {
  Feature,
  Polygon,
  LineString,
  FeatureCollection,
  MultiLineString,
  Position,
} from "geojson";

const initialUnion = (): s2.CellUnion | void => {
  // const union = new s2.CellUnion();
  // union.push(s2.cellid.fromFace(0));
  // union.push(s2.cellid.fromFace(1));
  // union.push(s2.cellid.fromFace(2));
  // union.push(s2.cellid.fromFace(3));
  // union.push(s2.cellid.fromFace(4));
  // union.push(s2.cellid.fromFace(5));
  // // union.push(2985886552946638848n);
  // // union.push(3008404551083491328n);
  // // union.push(3098476543630901248n);
  // // union.push(7710162562058289152n);
  // // union.push(7854277750134145024n);
  // // union.push(8286623314361712640n);
  // // union.push(11957057010668666880n);
  // // union.push(11979575008805519360n);
  // // union.push(12087661399862411264n);
  // // union.push(12393906174523604992n);
  // // union.push(5719853001737240576n);
  // // union.push(5476377146882523136n);
  // // union.push(4899916394579099648n);
  // // union.push(s2.cellid.fromToken("5b"));
  // // union.push(s2.cellid.fromToken("a4"));
  // // union.push(s2.cellid.fromToken("4c"));
  // return union;
};

const getCovering = (
  coverer: geojson.RegionCoverer,
  features: Feature[],
): s2.CellUnion => {
  return s2.CellUnion.fromUnion(
    ...features.map((f) => coverer.covering(f.geometry)),
  );
};

// We adjust the lines from great-circle to have lng > 180 and < -180 so that
// the polygons render correctly.
const overflowAntimeridianCrossings = (
  arcLines: FeatureCollection<LineString>,
) => {
  if (arcLines.features.length <= 4) return;

  const antimeridianCrossings: boolean[] = [];
  let antiCrossed = false;

  // find crossings
  let last = arcLines.features.at(-1)!.geometry.coordinates.at(-1)!;
  arcLines.features.forEach((f) => {
    const first = f.geometry.coordinates.at(0)!;
    if (
      (last[0] === 180 && first[0] === -180) ||
      (last[0] === -180 && first[0] === 180)
    ) {
      antiCrossed = !antiCrossed;
    }

    antimeridianCrossings.push(antiCrossed);
    last = f.geometry.coordinates.at(-1)!;
  });

  // wrap lats
  arcLines.features.forEach((f, fi) => {
    if (!antimeridianCrossings[fi]) return;
    f.geometry.coordinates.forEach((v) => (v[0] += 360));
  });
};

// The 'top' and 'bottom' faces are special-cased since all all points have equal lat.
// we add in an additional line segment so the top and bottom of the planar map are covered
// by the polygon.
const fixPolarFaces = (
  cellid: bigint,
  arcs: Feature<LineString | MultiLineString>[],
) => {
  const POLAR_FACES = [s2.cellid.fromFace(2), s2.cellid.fromFace(5)];
  if (!POLAR_FACES.includes(cellid)) return;

  arcs.forEach((arc: Feature<LineString | MultiLineString>) => {
    if (arc.geometry.type === "MultiLineString") {
      const A = arc.geometry.coordinates[0].at(-1)!;
      const B = arc.geometry.coordinates[1].at(0)!;

      // sanity checks
      if (!A || Math.abs(A[0]) !== 180 || !B || Math.abs(B[0]) !== 180) {
        return;
      }

      // the target polar latitude
      const E = Math.sign(A[0]) * 90;

      // draw a line to the pole, across, and back again
      arc.geometry.coordinates = [
        arc.geometry.coordinates[0],
        [A, [A[0], E], [B[0], E], B],
        arc.geometry.coordinates[1],
      ];
    }
  });
};

// When drawing to a pole the lng is not relevant, we borrow it from the previous point
// to avoid line drawing issues.
const fixPoles = (points: Position[]) => {
  points.forEach((p, i) => {
    if (Math.abs(p[1]) === 90) p[0] = points.at(i - 1)![0];
  });
};

// The great-circle lib can sometimes use -180 lng instead of +180 and vice-versa
const fixFalseAntimeridianCrossings = (points: Position[]) => {
  const exterior = points.filter((p) => Math.abs(p[0]) === 180);
  if (exterior.length !== 2) return;
  if (Math.sign(exterior[0][0]) !== Math.sign(exterior[1][0])) return;

  const interior = points.filter((p) => Math.abs(p[0]) !== 180);
  if (interior.length !== 2) return;
  if (Math.sign(interior[0][0]) !== Math.sign(interior[1][0])) return;

  exterior.forEach((p) => (p[0] = Math.sign(interior[0][0]) * 180));
};

// The great-circle lib can generate a linestring with two identical points, remove them.
const removeRedundantArcs = (arcs: Feature<LineString | MultiLineString>[]) => {
  arcs.forEach((arc: Feature<LineString | MultiLineString>) => {
    if (arc.geometry.type !== "MultiLineString") return;
    if (arc.geometry.coordinates.length !== 2) return;
    arc.geometry.coordinates = arc.geometry.coordinates.filter((ls) => {
      if (ls.length !== 2) return true;
      if (ls[0][0] === ls[1][0] && ls[0][1] === ls[1][1]) return false;
      return true;
    });
  });
};

const getCellVisualization = (union: s2.CellUnion): FeatureCollection => {
  let features = [...union].map((cellid): Feature<Polygon> => {
    const cell = s2.Cell.fromCellID(cellid);
    const poly = geojson.toGeoJSON(cell) as Polygon;
    const ring = poly.coordinates[0];

    fixPoles([ring[0], ring[1], ring[2], ring[3]]);
    fixFalseAntimeridianCrossings([ring[0], ring[1], ring[2], ring[3]]);

    const level = cell.level;
    const npoints = 20 + (30 - level) * 3; // more interpolated points for larger cells
    const arc0 = greatCircle(ring[0], ring[1], { npoints });
    const arc1 = greatCircle(ring[1], ring[2], { npoints });
    const arc2 = greatCircle(ring[2], ring[3], { npoints });
    const arc3 = greatCircle(ring[3], ring[0], { npoints });

    removeRedundantArcs([arc0, arc1, arc2, arc3]);
    fixPolarFaces(cellid, [arc0, arc1, arc2, arc3]);

    const arcLines: FeatureCollection<LineString> = {
      type: "FeatureCollection",
      features: [
        ...flatten(arc0).features,
        ...flatten(arc1).features,
        ...flatten(arc2).features,
        ...flatten(arc3).features,
      ],
    };

    overflowAntimeridianCrossings(arcLines);

    const coordinates = arcLines.features
      .map((f) => f.geometry.coordinates)
      .flat(1);

    const center = s2.LatLng.fromPoint(cell.center());

    return {
      type: "Feature",
      id: cell.id.toString(),
      geometry: {
        type: "Polygon",
        coordinates: [coordinates],
      },
      properties: {
        level: cell.level,
        token: s2.cellid.toToken(cell.id),
        centerLng: s1.angle.degrees(center.lng),
        centerLat: s1.angle.degrees(center.lat),
      },
    };
  });
  return {
    type: "FeatureCollection",
    features: features,
  };
};

function App() {
  let map: maplibregl.Map;
  let draw: TerraDraw;
  let regionCoverer: geojson.RegionCoverer;

  const [minLevel, setMinLevel] = createSignal(0);
  const [maxLevel, setMaxLevel] = createSignal(30);
  const [maxCells, setMaxCells] = createSignal(200);
  const [drawMode, setDrawMode] = createSignal("");
  const [cellUnionText, setCellUnionText] = createSignal("");
  const [geojsonText] = createSignal("");
  const [cellUnionLength, setCellUnionLength] = createSignal(0);
  const [loadError, setLoadError] = createSignal("");
  const [geojsonLoadError, setGeoJsonLoadError] = createSignal("");

  // list of features currently loaded in the map view
  const [features, setFeatures] = createSignal<Feature[]>([], {
    equals: () => false,
  });
  const clearFeatures = () => setFeatures((features) => features.slice(0, 0));
  const addFeatures = (additions: Feature[]) => {
    setFeatures((features) => {
      for (let feat of additions) {
        const hash = JSON.stringify(feat);
        const duplicate = features.some((f) => JSON.stringify(f) === hash);
        if (!duplicate) features.push(feat);
      }
      return features;
    });
  };

  // re-render covering when features / tokens change
  createEffect(() =>
    displayCovering(getCovering(regionCoverer, features()), features()),
  );

  let textArea: HTMLTextAreaElement | undefined;
  let jsonArea: HTMLTextAreaElement | undefined;

  const displayCovering = (covering: s2.CellUnion, features?: Feature[]) => {
    if (!map) return;

    const source: maplibregl.GeoJSONSource = map.getSource("covering")!;
    source.setData(getCellVisualization(covering));

    setCellUnionText([...covering].map((c) => s2.cellid.toToken(c)).join(", "));
    setCellUnionLength(covering.length);

    // dont zoom if all features are from terradraw
    if (
      features &&
      features.every((f) => f.id && f.id.toString().length === 36)
    ) {
      return;
    }

    const rect = covering.rectBound();
    map.fitBounds(
      [
        [s1.angle.degrees(rect.lng.lo), s1.angle.degrees(rect.lat.lo)],
        [s1.angle.degrees(rect.lng.hi), s1.angle.degrees(rect.lat.hi)],
      ],
      { padding: 50 },
    );
  };

  const loadCoveringFromText = () => {
    if (!textArea) return;

    try {
      const covering = new s2.CellUnion(
        ...textArea.value
          .trim()
          .split(",")
          .map((t) => t.trim())
          .map(s2.cellid.fromToken),
      );

      draw.clear();
      clearFeatures();
      displayCovering(covering);
      setLoadError("");
    } catch (e: any) {
      setLoadError(e.message);
    }
  };

  const loadGeoJsonFromText = () => {
    if (!jsonArea) return;

    try {
      const feature = JSON.parse(jsonArea.value) as Feature;
      if (feature?.type !== "Feature") throw new Error("Invalid Feature");
      clearFeatures();
      addFeatures([feature]);
      setGeoJsonLoadError("");
    } catch (e: any) {
      setGeoJsonLoadError(e.message.split(":")[0]);
    }
  };

  createEffect(() => {
    regionCoverer = new geojson.RegionCoverer({
      minLevel: minLevel(),
      maxLevel: maxLevel(),
      maxCells: maxCells(),
    });
    displayCovering(getCovering(regionCoverer, features()), features());
  });

  const clear = () => {
    draw.clear();
    clearFeatures();
    startDrawMode("rectangle");
  };

  const startDrawMode = (mode: string) => {
    if (draw) {
      draw.setMode(mode);
      setDrawMode(mode);
    }
  };

  onMount(() => {
    let basemapTheme = "white";
    let cellColor = "darkslategray";
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      basemapTheme = "black";
      cellColor = "yellow";
    }

    maplibregl.setRTLTextPlugin(
      "https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js",
      true,
    );

    map = new maplibregl.Map({
      container: "map",
      style: `https://api.protomaps.com/styles/v4/${basemapTheme}/en.json?key=5b9c1298c2eef269`,
      maplibreLogo: true,
    });

    const options = {
      styles: {
        outlineWidth: 0,
      },
    };

    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, maplibregl }),
      modes: [
        new TerraDrawRectangleMode(options),
        new TerraDrawRenderMode({ modeName: "render", styles: {} }),
        new TerraDrawPolygonMode(options),
      ],
    });

    draw.on("finish", () => {
      startDrawMode("render");
      addFeatures(draw.getSnapshot());
    });

    draw.start();

    startDrawMode("rectangle");

    map.on("load", () => {
      map.addSource("covering", {
        type: "geojson",
        data: {
          type: "MultiPolygon",
          coordinates: [],
        },
      });
      map.addLayer({
        id: "covering-fill",
        type: "fill",
        source: "covering",
        paint: {
          "fill-color": cellColor,
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            0.7,
            0.5,
          ],
        },
      });
      map.addLayer({
        id: "covering-stroke",
        type: "line",
        source: "covering",
        paint: {
          "line-color": cellColor,
        },
      });
      map.addLayer({
        id: "covering-label",
        type: "symbol",
        source: "covering",
        filter: ["<=", ["get", "level"], ["+", ["zoom"], 3]],
        layout: {
          "text-font": ["Noto Sans Medium"],
          "text-field": ["get", "level"],
          "text-size": 10,
        },
        paint: {
          "text-color": cellColor,
        },
      });

      let hoveredCellId: string | number | undefined;

      map.on("mousemove", "covering-fill", (e) => {
        if (e.features && e.features.length > 0) {
          if (hoveredCellId) {
            map.setFeatureState(
              { source: "covering", id: hoveredCellId },
              { hover: false },
            );
          }
          hoveredCellId = e.features[0].id;
          map.setFeatureState(
            { source: "covering", id: hoveredCellId },
            { hover: true },
          );
        }
        map.getCanvas().style.cursor = drawMode() === "render" ? "pointer" : "";
      });

      map.on("mouseleave", "covering-fill", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", "covering-fill", (e) => {
        if (!e || !e.features || e.features.length === 0) return;
        const properties = e.features[0].properties;
        const coordinates = {
          lng: properties.centerLng,
          lat: properties.centerLat,
        };

        while (Math.abs(e.lngLat.lng - coordinates.lng) > 180) {
          coordinates.lng += e.lngLat.lng > coordinates.lng ? 360 : -360;
        }

        new maplibregl.Popup({ closeButton: false })
          .setLngLat(coordinates)
          .setHTML(
            `<div>
              <div>Level ${properties.level}</div>
              <div>${properties.token}</div>
            </div>`,
          )
          .addTo(map);
      });

      // initialize the view with a predefined union
      const init = initialUnion();
      if (init && init.length) {
        (map!.getSource("covering") as maplibregl.GeoJSONSource).setData(
          getCellVisualization(init),
        );
      }
    });
  });

  return (
    <div class="container">
      <div class="sidebar">
        <div class="controls">
          <div class="draw">
            <button
              class={drawMode() === "rectangle" ? "active" : ""}
              onClick={() => startDrawMode("rectangle")}
            >
              Draw Rectangle
            </button>
            <button
              class={drawMode() === "polygon" ? "active" : ""}
              onClick={() => startDrawMode("polygon")}
            >
              Draw Polygon
            </button>
            <button onClick={clear}>Clear</button>
          </div>
          <div class="input">
            <div class="label">
              <label>max cells per shape:</label>
            </div>
            <input
              type="text"
              value={maxCells()}
              onInput={(e) => {
                setMaxCells(+e.target.value || 1);
              }}
            />
          </div>
          <div class="input">
            <div class="label">
              <label>min level:</label>
            </div>
            <input
              type="number"
              min="0"
              max="30"
              required
              value={minLevel()}
              onInput={(e) => {
                setMinLevel(+e.target.value || 1);
              }}
            />
          </div>
          <div class="input">
            <div class="label">
              <label>max level:</label>
            </div>
            <input
              type="number"
              min="0"
              max="30"
              required
              value={maxLevel()}
              onInput={(e) => {
                setMaxLevel(+e.target.value || 1);
              }}
            />
          </div>
          <textarea ref={textArea} rows="5" value={cellUnionText()}></textarea>
          <div class="textarealabel">
            {loadError() ? (
              <span>{loadError()}</span>
            ) : (
              <span>{cellUnionLength()} cells</span>
            )}
            <button onClick={loadCoveringFromText}>Load Tokens</button>
          </div>
          <textarea ref={jsonArea} rows="5" value={geojsonText()}></textarea>
          <div class="textarealabel">
            {geojsonLoadError() ? (
              <span>{geojsonLoadError()}</span>
            ) : (
              <span></span>
            )}
            <button onClick={loadGeoJsonFromText}>Load GeoJSON</button>
          </div>
        </div>
        <div class="text">
          <h1>s2js Demo</h1>
          <p>
            Visual demo of{" "}
            <a target="_blank" href="https://github.com/missinglink/s2js">
              s2js
            </a>
            , a pure TypeScript implementation of{" "}
            <a href="http://s2geometry.io" target="_blank">
              S2 Geometry.
            </a>
            <br />
            Draw any region to see its cell covering.
            <br />
            Built with{" "}
            <a target="_blank" href="http://terradraw.io">
              Terra Draw
            </a>
            ,{" "}
            <a target="_blank" href="http://maplibre.org">
              MapLibre
            </a>{" "}
            and{" "}
            <a target="_blank" href="https://github.com/protomaps">
              Protomaps
            </a>{" "}
            tiles.
          </p>
          <p class="faq">
            <strong>Why don't the cells seem to cover my region?</strong> The
            library interprets edges in the input as geodesics; this can be
            mitigated by shorter distances between boundary vertices.
          </p>
          <a href="https://github.com/bdon/s2js-demos">Fork me on GitHub</a>
        </div>
      </div>
      <div id="map"></div>
    </div>
  );
}

export default App;
