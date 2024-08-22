import { onMount } from "solid-js";
import "./App.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { s2, s1 } from "s2js";
import {
  TerraDraw,
  TerraDrawMapLibreGLAdapter,
  TerraDrawRectangleMode
} from "terra-draw";
import { Polygon, FeatureCollection } from "geojson";

const getPolygonCovering = (regionCoverer: s2.RegionCoverer, polygon: Polygon):s2.CellUnion => {
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
}

const getPolygonsCovering = (regionCoverer: s2.RegionCoverer, polygons: Polygon[]):s2.CellUnion => {
  return s2.CellUnion.fromUnion(...polygons.map(p => getPolygonCovering(regionCoverer, p)))
}

const getCellVisualization = (union: s2.CellUnion):FeatureCollection => {
  const degrees = s1.angle.degrees;
  let features = union.map(cellid => {
    const cell = s2.Cell.fromCellID(cellid);
    const v0 = s2.LatLng.fromPoint(cell.vertex(0));
    const v1 = s2.LatLng.fromPoint(cell.vertex(1));
    const v2 = s2.LatLng.fromPoint(cell.vertex(2));
    const v3 = s2.LatLng.fromPoint(cell.vertex(3));
    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [degrees(v0.lng), degrees(v0.lat)],
            [degrees(v1.lng), degrees(v1.lat)],
            [degrees(v2.lng), degrees(v2.lat)],
            [degrees(v3.lng), degrees(v3.lat)],
            [degrees(v0.lng), degrees(v0.lat)],
          ] 
        ]
      },
      properties: {
        level: 0
      }
    }

  });
  return {
    type: "FeatureCollection",
    features: features
  }
}

function App() {
  let map: maplibregl.Map;
  let draw: TerraDraw;
  let regionCoverer: s2.RegionCoverer;

  const updateCovering = () => {
    const polygons:Polygon[] = draw!.getSnapshot().map(f => f.geometry).filter(g => g.type === "Polygon");
    const covering = getPolygonsCovering(regionCoverer, polygons);
    map!.getSource("covering")!.setData(getCellVisualization(covering));
  };

  onMount(() => {
    map = new maplibregl.Map({
      container: "map", // container id
      style: "https://demotiles.maplibre.org/style.json", // style URL
      center: [0, 0], // starting position [lng, lat]
      zoom: 1, // starting zoom
      maplibreLogo: true,
    });

    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, maplibregl }),
      modes: [new TerraDrawRectangleMode()],
    });

    draw.on("finish", () => {
      updateCovering();
    });

    draw.start();
    draw.setMode("rectangle");

    regionCoverer = new s2.RegionCoverer({ maxLevel: 30, maxCells: 1000 });

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
          "fill-color": "steelblue",
          "fill-opacity": 0.5,
        },
      });
      map.addLayer({
        id: "covering-stroke",
        type: "line",
        source: "covering",
        paint: {
          "line-color": "steelblue",
        },
      });
    });
  });

  return (
    <div class="container">
      <div class="controls"></div>
      <div id="map"></div>
    </div>
  );
}

export default App;
