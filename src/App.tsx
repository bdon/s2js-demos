import { createSignal, createEffect, onMount } from "solid-js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";
import maplibregl from "maplibre-gl";
import { r1, s2, s1 } from "s2js";
import { greatCircle } from "@turf/great-circle";
import { flatten } from "@turf/flatten";
import { rewind } from "@turf/rewind";
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

const polygonBuilder = (polygon: Polygon): s2.Polygon => {
  rewind(polygon, { mutate: true });
  const points = [];
  const ring = polygon.coordinates[0]; // TODO assume only the first ring
  for (let i = 0; i < ring.length - 1; i++) {
    const latlng = s2.LatLng.fromDegrees(ring[i][1], ring[i][0]);
    points.push(s2.Point.fromLatLng(latlng));
  }
  const loop = new s2.Loop(points);
  return s2.Polygon.fromOrientedLoops([loop]);
};

const rectBuilder = (polygon: Polygon): s2.Rect => {
  const coords = polygon.coordinates[0]; // TODO assume only the first ring
  const latLo = Math.min(coords[0][1], coords[2][1]);
  const lngLo = Math.min(coords[0][0], coords[2][0]);
  const latHi = Math.max(coords[0][1], coords[2][1]);
  const lngHi = Math.max(coords[0][0], coords[2][0]);

  const DEGREE = Math.PI / 180;
  return new s2.Rect(
    new r1.Interval(latLo * DEGREE, latHi * DEGREE),
    s1.Interval.fromEndpoints(lngLo * DEGREE, lngHi * DEGREE),
  );
};

const getCovering = (
  regionCoverer: s2.RegionCoverer,
  features: Feature<Polygon>[],
): s2.CellUnion => {
  return s2.CellUnion.fromUnion(
    ...features.map((f) => {
      if (f.properties!.mode === "rectangle") {
        return regionCoverer!.covering(rectBuilder(f.geometry));
      } else {
        return regionCoverer!.covering(polygonBuilder(f.geometry));
      }
    }),
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
const fixPoles = (points: number[][]) => {
  points.forEach((p, i) => {
    if (Math.abs(p[1]) === 90) p[0] = points.at(i - 1)![0];
  });
};

//The great-circle lib can sometimes use -180 lng instead of +180 and vice-versa
const fixFalseAntimeridianCrossings = (points: number[][]) => {
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
  const degrees = s1.angle.degrees;
  let features = [...union].map((cellid): Feature<Polygon> => {
    const cell = s2.Cell.fromCellID(cellid);
    const v0 = s2.LatLng.fromPoint(cell.vertex(0));
    const v1 = s2.LatLng.fromPoint(cell.vertex(1));
    const v2 = s2.LatLng.fromPoint(cell.vertex(2));
    const v3 = s2.LatLng.fromPoint(cell.vertex(3));

    const p0 = [degrees(v0.lng) || 0, degrees(v0.lat) || 0];
    const p1 = [degrees(v1.lng) || 0, degrees(v1.lat) || 0];
    const p2 = [degrees(v2.lng) || 0, degrees(v2.lat) || 0];
    const p3 = [degrees(v3.lng) || 0, degrees(v3.lat) || 0];

    fixPoles([p0, p1, p2, p3]);
    fixFalseAntimeridianCrossings([p0, p1, p2, p3]);

    const level = cell.level;
    const npoints = 20 + (30 - level) * 3;
    const arc0 = greatCircle(p0, p1, { npoints });
    const arc1 = greatCircle(p1, p2, { npoints });
    const arc2 = greatCircle(p2, p3, { npoints });
    const arc3 = greatCircle(p3, p0, { npoints });

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
  let regionCoverer: s2.RegionCoverer;

  const [maxLevel, setMaxLevel] = createSignal(30);
  const [maxCells, setMaxCells] = createSignal(200);
  const [drawMode, setDrawMode] = createSignal("");
  const [cellUnionText, setCellUnionText] = createSignal("");
  const [cellUnionLength, setCellUnionLength] = createSignal(0);
  const [loadError, setLoadError] = createSignal("");
  let textArea: HTMLTextAreaElement | undefined;

  const computeCoveringForDraw = () => {
    const snapshot = draw!.getSnapshot() as Feature<Polygon>[];

    const covering = getCovering(regionCoverer, snapshot);
    displayCovering(covering);
  };

  const displayCovering = (covering: s2.CellUnion) => {
    (map!.getSource("covering") as maplibregl.GeoJSONSource).setData(
      getCellVisualization(covering),
    );

    setCellUnionText([...covering].map((c) => s2.cellid.toToken(c)).join(", "));
    setCellUnionLength(covering.length);
  };

  const loadCoveringFromText = () => {
    let rect = s2.Rect.emptyRect();

    draw.clear();
    if (!textArea) return;

    try {
      const covering = new s2.CellUnion(
        ...textArea.value.split(", ").map((token) => {
          const cellid = s2.cellid.fromToken(token);
          const cell = s2.Cell.fromCellID(cellid);
          rect = rect.union(cell.rectBound());
          return cellid;
        }),
      );

      displayCovering(covering);
      map.fitBounds([
        [s1.angle.degrees(rect.lng.lo), s1.angle.degrees(rect.lat.lo)],
        [s1.angle.degrees(rect.lng.hi), s1.angle.degrees(rect.lat.hi)],
      ]);
      setLoadError("");
    } catch (e: any) {
      setLoadError(e.message);
    }
  };

  createEffect(() => {
    regionCoverer = new s2.RegionCoverer({
      maxLevel: maxLevel(),
      maxCells: maxCells(),
    });
    if (draw) {
      computeCoveringForDraw();
    }
  });

  const clear = () => {
    draw.clear();
    computeCoveringForDraw();
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
      style: `https://api.protomaps.com/styles/v3/${basemapTheme}.json?key=5b9c1298c2eef269`,
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
      computeCoveringForDraw();
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
        map.getCanvas().style.cursor = "pointer";
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
              <label>max level:</label>
            </div>
            <input
              type="text"
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
            <button onClick={loadCoveringFromText}>Load Text</button>
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
