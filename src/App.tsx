import { createSignal, createEffect, onMount } from "solid-js";
import "./App.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { r1, s2, s1 } from "s2js";
import { point, greatCircle, featureCollection, polygonize } from "@turf/turf";
import {
  TerraDraw,
  TerraDrawMapLibreGLAdapter,
  TerraDrawRectangleMode,
  TerraDrawAngledRectangleMode,
  TerraDrawPolygonMode,
  TerraDrawCircleMode,
} from "terra-draw";
import { Polygon, FeatureCollection } from "geojson";

const polygonBuilder = (polygon: Polygon): s2.Polygon => {
  const points = [];
  const ring = polygon.coordinates[0]; // TODO assume only the first ring
  for (let i = 0; i < ring.length - 1; i++) {
    const latlng = s2.LatLng.fromDegrees(ring[i][1], ring[i][0]).normalized();
    points.push(s2.Point.fromLatLng(latlng));
  }
  const loop = new s2.Loop(points);
  loop.normalize();
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
  polygons: Polygon[],
  regionBuilder: { (polygon: Polygon): s2.Region },
): s2.CellUnion => {
  return s2.CellUnion.fromUnion(
    ...polygons.map((p) => regionCoverer!.covering(regionBuilder(p))),
  );
};

const getCellVisualization = (union: s2.CellUnion): FeatureCollection => {
  const degrees = s1.angle.degrees;
  let collections = [...union].map((cellid) => {
    const cell = s2.Cell.fromCellID(cellid);
    const v0 = s2.LatLng.fromPoint(cell.vertex(0));
    const v1 = s2.LatLng.fromPoint(cell.vertex(1));
    const v2 = s2.LatLng.fromPoint(cell.vertex(2));
    const v3 = s2.LatLng.fromPoint(cell.vertex(3));

    const p0 = point([degrees(v0.lng), degrees(v0.lat)]);
    const p1 = point([degrees(v1.lng), degrees(v1.lat)]);
    const p2 = point([degrees(v2.lng), degrees(v2.lat)]);
    const p3 = point([degrees(v3.lng), degrees(v3.lat)]);

    const level = s2.cellid.level(cellid);
    const npoints = (30 - level) * 5;
    const arc0 = greatCircle(p0, p1, { npoints });
    const arc1 = greatCircle(p1, p2, { npoints });
    const arc2 = greatCircle(p2, p3, { npoints });
    const arc3 = greatCircle(p3, p0, { npoints });

    let collection = featureCollection([arc0, arc1, arc2, arc3]);
    try {
      return polygonize(collection);
    } catch (e) {
      console.error("polygonize error");
      console.error(e);
    }

    return collection;
  });
  return {
    type: "FeatureCollection",
    features: collections.map((c) => c.features).flat(1),
  };
};

function App() {
  let map: maplibregl.Map;
  let draw: TerraDraw;
  let regionCoverer: s2.RegionCoverer;

  const [maxLevel, setMaxLevel] = createSignal(30);
  const [maxCells, setMaxCells] = createSignal(200);

  const updateCovering = () => {
    const snapshot = draw!.getSnapshot();
    if (!snapshot.length) return;

    const polygons: Polygon[] = snapshot
      .map((f) => f.geometry)
      .filter((g) => g.type === "Polygon");

    let covering;
    switch (snapshot[0].properties.mode) {
      case "rectangle": {
        console.error("rectangle covering");
        covering = getCovering(regionCoverer, polygons, rectBuilder);
        break;
      }
      default: {
        console.error("polygon covering");
        covering = getCovering(regionCoverer, polygons, polygonBuilder);
      }
    }
    (map!.getSource("covering") as maplibregl.GeoJSONSource).setData(
      getCellVisualization(covering),
    );
  };

  createEffect(() => {
    regionCoverer = new s2.RegionCoverer({
      maxLevel: maxLevel(),
      maxCells: maxCells(),
    });
    if (draw) {
      updateCovering();
    }
  });

  const clear = () => {
    draw.clear();
    updateCovering();
  };

  onMount(() => {
    map = new maplibregl.Map({
      container: "map",
      style:
        "https://api.protomaps.com/styles/v3/black.json?key=5b9c1298c2eef269",
      maplibreLogo: true,
    });

    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, maplibregl }),
      modes: [
        new TerraDrawRectangleMode(),
        new TerraDrawAngledRectangleMode(),
        new TerraDrawPolygonMode(),
        new TerraDrawCircleMode(),
      ],
    });

    draw.on("finish", () => {
      updateCovering();
    });

    draw.start();
    draw.setMode("rectangle");

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
          "fill-color": "yellow",
          "fill-opacity": 0.5,
        },
      });
      map.addLayer({
        id: "covering-stroke",
        type: "line",
        source: "covering",
        paint: {
          "line-color": "yellow",
        },
      });
    });
  });

  return (
    <div class="container">
      <div class="controls">
        <select
          onChange={(e) => {
            if (draw) {
              draw.setMode(e.target.value);
            }
          }}
        >
          <option value="rectangle">rectangle mode</option>
          <option value="polygon">polygon mode</option>
          <option value="angled-rectangle">angled rectangle mode</option>
          <option value="circle">circle mode</option>
        </select>
        <p>
          max cells:{" "}
          <input
            type="text"
            value={maxCells()}
            onInput={(e) => {
              setMaxCells(+e.target.value || 1);
            }}
          />
        </p>
        <p>
          max level:{" "}
          <input
            type="text"
            value={maxLevel()}
            onInput={(e) => {
              setMaxLevel(+e.target.value || 1);
            }}
          />
        </p>
        <button onClick={clear}>clear</button>
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
          <strong>Why are there gaps between cells?</strong> The visual cells
          are approximated by trapezoids; in reality they are geodesics, or
          straight on great circles.
        </p>
        <p class="faq">
          <strong>Why don't the cells cover my region?</strong> The library
          interprets edges in the input also as geodesics; this can be mitigated
          by shorter distances between boundary vertices.
        </p>
        <a href="https://github.com/bdon/s2js-demos">Fork me on GitHub</a>
      </div>
      <div id="map"></div>
    </div>
  );
}

export default App;
