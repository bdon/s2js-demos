import { createSignal, createEffect, onMount } from "solid-js";
import "./App.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { s2, s1 } from "s2js";
import {
  TerraDraw,
  TerraDrawMapLibreGLAdapter,
  TerraDrawRectangleMode,
  TerraDrawAngledRectangleMode,
  TerraDrawPolygonMode,
  TerraDrawCircleMode,
} from "terra-draw";
import { Polygon, FeatureCollection } from "geojson";

const getPolygonCovering = (
  regionCoverer: s2.RegionCoverer,
  polygon: Polygon,
): s2.CellUnion => {
  const points = [];
  const ring = polygon.coordinates[0]; // TODO assume only the first ring
  for (let i = 0; i < ring.length - 1; i++) {
    const latlng = s2.LatLng.fromDegrees(ring[i][1], ring[i][0]).normalized();
    points.push(s2.Point.fromLatLng(latlng));
  }
  const loop = new s2.Loop(points);
  loop.normalize();
  const s2poly = s2.Polygon.fromOrientedLoops([loop]);
  return regionCoverer!.covering(s2poly);
};

const getPolygonsCovering = (
  regionCoverer: s2.RegionCoverer,
  polygons: Polygon[],
): s2.CellUnion => {
  return s2.CellUnion.fromUnion(
    ...polygons.map((p) => getPolygonCovering(regionCoverer, p)),
  );
};

const getCellVisualization = (union: s2.CellUnion): FeatureCollection => {
  const degrees = s1.angle.degrees;
  let features = union.map((cellid) => {
    const cell = s2.Cell.fromCellID(cellid);
    const v0 = s2.LatLng.fromPoint(cell.vertex(0));
    const v1 = s2.LatLng.fromPoint(cell.vertex(1));
    const v2 = s2.LatLng.fromPoint(cell.vertex(2));
    const v3 = s2.LatLng.fromPoint(cell.vertex(3));
    return {
      type: "Feature" as "Feature",
      geometry: {
        type: "Polygon" as "Polygon",
        coordinates: [
          [
            [degrees(v0.lng), degrees(v0.lat)],
            [degrees(v1.lng), degrees(v1.lat)],
            [degrees(v2.lng), degrees(v2.lat)],
            [degrees(v3.lng), degrees(v3.lat)],
            [degrees(v0.lng), degrees(v0.lat)],
          ],
        ],
      },
      properties: {
        level: 0,
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

  const updateCovering = () => {
    const polygons: Polygon[] = draw!
      .getSnapshot()
      .map((f) => f.geometry)
      .filter((g) => g.type === "Polygon");
    const covering = getPolygonsCovering(regionCoverer, polygons);
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

      <div class="sidebar">

        <div class="controls">

          <div class="input">
            <div class="label">
              <label>
                draw mode:
              </label>
            </div>
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
          </div>

          <div class="input">
            <div class="label">
              <label>
                max cells:
              </label>
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
              <label>
                max level:
              </label>
            </div>
            <input
              type="text"
              value={maxLevel()}
              onInput={(e) => {
                setMaxLevel(+e.target.value || 1);
              }}
            />
          </div>
          <button onClick={clear}>clear</button>
        </div>
        <div class="text">
          <h1>s2js Demo</h1>
          <p>
            Visual demo of <a target="_blank" href="https://github.com/missinglink/s2js">s2js</a>, a pure TypeScript implementation of <a href="http://s2geometry.io" target="_blank">S2 Geometry.</a><br />

            Draw any region to see its cell covering.<br />

            Built with <a target="_blank" href="http://terradraw.io">Terra Draw</a>, <a target="_blank" href="http://maplibre.org">MapLibre</a> and <a target="_blank" href="https://github.com/protomaps">Protomaps</a> tiles.
          </p>
          <p class="faq">
            <strong>Why are there gaps between cells?</strong> The visual cells are approximated by trapezoids; in reality they are geodesics, or straight on great circles.
          </p>
          <p class="faq">
            <strong>Why don't the cells cover my region?</strong> The library interprets edges in the input also as geodesics; this can be mitigated by shorter distances between boundary vertices.
          </p>
          <a href="https://github.com/bdon/s2js-demos">Fork me on GitHub</a>
        </div>
      </div>
      <div id="map"></div>
    </div >
  );
}

export default App;
