import * as Format from "@iosevka/util/formatter";
import * as TypoGeom from "typo-geom";

import * as CurveUtil from "./curve-util.mjs";
import { Point } from "./point.mjs";
import { QuadifySink } from "./quadify.mjs";
import { SpiroExpander } from "./spiro-expand.mjs";
import { spiroToOutlineWithSimplification } from "./spiro-to-outline.mjs";
import { strokeArcs } from "./stroke.mjs";
import { Transform } from "./transform.mjs";

export const CPLX_NON_EMPTY = 0x01; // A geometry tree that is not empty
export const CPLX_NON_SIMPLE = 0x02; // A geometry tree that contains non-simple contours
export const CPLX_BROKEN = 0x04; // A geometry tree that contains broken contours
export const CPLX_UNKNOWN = 0xff;

export class GeometryBase {
	toContours(ctx) {
		throw new Error("Unimplemented");
	}
	toReferences() {
		throw new Error("Unimplemented");
	}
	getDependencies() {
		throw new Error("Unimplemented");
	}
	unlinkReferences() {
		return this;
	}
	filterTag(fn) {
		return this;
	}
	measureComplexity() {
		return CPLX_UNKNOWN;
	}

	hash(h) {
		return h.invalid();
	}
}

export class InvalidGeometry extends GeometryBase {}

export class ContourSetGeometry extends GeometryBase {
	constructor(contours) {
		super();
		this.m_contours = contours;
	}
	toContours(ctx) {
		return this.m_contours;
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		return null;
	}
	filterTag(fn) {
		return this;
	}
	measureComplexity() {
		let cp = this.m_contours.length > 0 ? CPLX_NON_EMPTY : 0;
		for (const c of this.m_contours) {
			for (const z of c) {
				if (!isFinite(z.x) || !isFinite(z.y)) cp |= CPLX_BROKEN;
			}
		}
		return cp;
	}
	hash(h) {
		h.beginStruct("ContourSetGeometry");
		h.beginArray(this.m_contours.length);
		for (const c of this.m_contours) {
			h.beginArray(c.length);
			for (const z of c) h.typedPoint(z);
			h.endArray();
		}
		h.endArray();
		h.endStruct();
	}
}

// Enabling geometry cache over the deep nodes of the geometry tree
export class CachedGeometry extends GeometryBase {
	toContours(ctx) {
		let ck = null;
		if (ctx && ctx.cache) {
			ck = hashGeometry(this);
			const gf = ctx.cache.getGF(ck);
			if (gf) {
				ctx.cache.refreshGF(ck);
				return gf;
			}
		}

		const outline = this.toContoursImpl(ctx);
		if (ck && ctx && ctx.cache) ctx.cache.saveGF(ck, outline);

		return outline;
	}

	toContoursImpl() {
		throw new Error("Unimplemented");
	}
}

export class SpiroGeometry extends CachedGeometry {
	constructor(gizmo, closed, knots) {
		super();
		this.m_knots = knots;
		this.m_closed = closed;
		this.m_gizmo = gizmo;
	}
	toContoursImpl() {
		return spiroToOutlineWithSimplification(this.m_knots, this.m_closed, this.m_gizmo);
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		return null;
	}
	filterTag(fn) {
		return this;
	}
	measureComplexity() {
		let cplx = CPLX_NON_EMPTY | CPLX_NON_SIMPLE;
		for (const z of this.m_knots) {
			if (!isFinite(z.x) || !isFinite(z.y)) cplx |= CPLX_BROKEN;
		}
		return cplx;
	}

	hash(h) {
		h.beginStruct("SpiroGeometry");
		h.gizmo(this.m_gizmo);
		h.bool(this.m_closed);
		h.beginArray(this.m_knots.length);
		for (const knot of this.m_knots) h.embed(knot);
		h.endArray();
		h.endStruct();
	}
}

export class DiSpiroGeometry extends CachedGeometry {
	constructor(gizmo, contrast, closed, biKnots) {
		super();
		this.m_biKnots = biKnots; // untransformed
		this.m_closed = closed;
		this.m_gizmo = gizmo;
		this.m_contrast = contrast;
	}

	toContoursImpl() {
		const expandResult = this.expand();
		const lhs = [...expandResult.lhsUntransformed];
		const rhs = [...expandResult.rhsUntransformed];
		// Reverse the RHS
		for (const k of rhs) k.reverseType();
		rhs.reverse();

		if (this.m_closed) {
			return [
				...new SpiroGeometry(this.m_gizmo, true, lhs).toContoursImpl(),
				...new SpiroGeometry(this.m_gizmo, true, rhs).toContoursImpl(),
			];
		} else {
			lhs[0].type = lhs[lhs.length - 1].type = "corner";
			rhs[0].type = rhs[rhs.length - 1].type = "corner";
			const allKnots = lhs.concat(rhs);
			return new SpiroGeometry(this.m_gizmo, true, allKnots).toContoursImpl();
		}
	}

	expand() {
		const expander = new SpiroExpander(
			this.m_gizmo,
			this.m_contrast,
			this.m_closed,
			this.m_biKnots,
		);
		expander.initializeNormals();
		for (let r = 0; r < 8; r++) {
			let d = expander.iterateNormals();
			if (d < 1e-8) break;
		}
		return expander.expand();
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		return null;
	}
	filterTag(fn) {
		return this;
	}
	measureComplexity() {
		let cplx = CPLX_NON_EMPTY | CPLX_NON_SIMPLE;
		for (const z of this.m_biKnots) {
			if (!isFinite(z.x) || !isFinite(z.y)) cplx |= CPLX_BROKEN;
		}
		return cplx;
	}

	hash(h) {
		h.beginStruct("DiSpiroGeometry");
		h.gizmo(this.m_gizmo);
		h.f64(this.m_contrast);
		h.bool(this.m_closed);
		h.beginArray(this.m_biKnots.length);
		for (const knot of this.m_biKnots) h.embed(knot);
		h.endArray();
		h.endStruct();
	}
}

export class ReferenceGeometry extends GeometryBase {
	constructor(glyph, x, y) {
		super();
		if (!glyph || !glyph.geometry) throw new TypeError("Invalid glyph");
		this.m_glyph = glyph;
		this.m_x = x || 0;
		this.m_y = y || 0;
	}
	unwrap() {
		return new TransformedGeometry(
			Transform.Translate(this.m_x, this.m_y),
			this.m_glyph.geometry,
		);
	}
	toContours(ctx) {
		return this.unwrap().toContours(ctx);
	}
	toReferences() {
		if (this.m_glyph.geometry.measureComplexity() & CPLX_NON_EMPTY) {
			return [{ glyph: this.m_glyph, x: this.m_x, y: this.m_y }];
		} else {
			// A reference to a space is meaningless, thus return nothing
			return [];
		}
	}
	getDependencies() {
		return [this.m_glyph];
	}
	filterTag(fn) {
		return this.unwrap().filterTag(fn);
	}
	measureComplexity() {
		return this.m_glyph.geometry.measureComplexity();
	}
	unlinkReferences() {
		return this.unwrap().unlinkReferences();
	}

	hash(h) {
		h.beginStruct("ReferenceGeometry");
		h.embed(this.m_glyph.geometry);
		h.f64(this.m_x);
		h.f64(this.m_y);
		h.endStruct();
	}
}

export class TaggedGeometry extends GeometryBase {
	constructor(g, tag) {
		super();
		this.m_geom = g;
		this.m_tag = tag;
	}
	toContours(ctx) {
		return this.m_geom.toContours(ctx);
	}
	toReferences() {
		return this.m_geom.toReferences();
	}
	getDependencies() {
		return this.m_geom.getDependencies();
	}
	filterTag(fn) {
		if (!fn(this.m_tag)) return null;
		else return new TaggedGeometry(this.m_geom.filterTag(fn), this.m_tag);
	}
	measureComplexity() {
		return this.m_geom.measureComplexity();
	}
	unlinkReferences() {
		return this.m_geom.unlinkReferences();
	}

	hash(h) {
		this.m_geom.hash(h);
	}
}

export class TransformedGeometry extends GeometryBase {
	constructor(tfm, g) {
		super();
		this.m_transform = tfm;
		this.m_geom = g;
	}

	withTransform(tfm) {
		return new TransformedGeometry(Transform.Combine(this.m_transform, tfm), this.m_geom);
	}

	toContours(ctx) {
		let result = [];
		for (const c of this.m_geom.toContours(ctx)) {
			let c1 = [];
			for (const z of c) c1.push(Point.transformed(this.m_transform, z));
			result.push(c1);
		}
		return result;
	}
	toReferences() {
		if (!Transform.isTranslate(this.m_transform)) return null;
		const rs = this.m_geom.toReferences();
		if (!rs) return null;
		let result = [];
		for (const { glyph, x, y } of rs)
			result.push({ glyph, x: x + this.m_transform.tx, y: y + this.m_transform.ty });
		return result;
	}
	getDependencies() {
		return this.m_geom.getDependencies();
	}
	filterTag(fn) {
		const e = this.m_geom.filterTag(fn);
		if (!e) return null;
		return new TransformedGeometry(this.m_transform, e);
	}
	measureComplexity() {
		return (
			(Transform.isPositive(this.m_transform) ? 0 : CPLX_NON_SIMPLE) |
			this.m_geom.measureComplexity()
		);
	}
	unlinkReferences() {
		const unwrapped = this.m_geom.unlinkReferences();
		if (Transform.isIdentity(this.m_transform)) {
			return unwrapped;
		} else if (unwrapped instanceof TransformedGeometry) {
			return unwrapped.withTransform(this.m_transform);
		} else {
			return new TransformedGeometry(this.m_transform, unwrapped);
		}
	}

	hash(h) {
		h.beginStruct("TransformedGeometry");
		h.gizmo(this.m_transform);
		h.embed(this.m_geom);
		h.endStruct();
		return h;
	}
}

export class RadicalGeometry extends GeometryBase {
	constructor(g) {
		super();
		this.m_geom = g;
	}
	toContours(ctx) {
		return this.m_geom.toContours(ctx);
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		return this.m_geom.getDependencies();
	}
	filterTag(fn) {
		const e = this.m_geom.filterTag(fn);
		if (!e) return null;
		return new RadicalGeometry(e);
	}
	measureComplexity() {
		return this.m_geom.measureComplexity();
	}
	unlinkReferences() {
		return this.m_geom.unlinkReferences();
	}

	hash(h) {
		this.m_geom.hash(h);
	}
}

export class CombineGeometry extends GeometryBase {
	constructor(parts) {
		super();
		this.m_parts = parts || [];
	}
	with(g) {
		if (g instanceof CombineGeometry) {
			return new CombineGeometry([...this.m_parts, ...g.m_parts]);
		} else {
			return new CombineGeometry([...this.m_parts, g]);
		}
	}
	toContours(ctx) {
		let results = [];
		for (const part of this.m_parts) {
			for (const c of part.toContours(ctx)) {
				results.push(c);
			}
		}
		return results;
	}
	toReferences() {
		let results = [];
		for (const part of this.m_parts) {
			const rs = part.toReferences();
			if (!rs) return null;
			for (const c of rs) {
				results.push(c);
			}
		}
		return results;
	}
	getDependencies() {
		let results = [];
		for (const part of this.m_parts) {
			const rs = part.getDependencies();
			if (!rs) continue;
			for (const c of rs) results.push(c);
		}
		return results;
	}
	filterTag(fn) {
		let filtered = [];
		for (const part of this.m_parts) {
			const fp = part.filterTag(fn);
			if (fp) filtered.push(fp);
		}
		return new CombineGeometry(filtered);
	}
	measureComplexity() {
		let s = 0;
		for (const part of this.m_parts) s |= part.measureComplexity();
		return s;
	}
	unlinkReferences() {
		let parts = [];
		for (const part of this.m_parts) {
			const unwrapped = part.unlinkReferences();
			if (unwrapped instanceof CombineGeometry) {
				for (const p of unwrapped.m_parts) parts.push(p);
			} else {
				parts.push(unwrapped);
			}
		}
		return new CombineGeometry(parts);
	}

	hash(h) {
		h.beginStruct("CombineGeometry");
		h.beginArray(this.m_parts.length);
		for (const part of this.m_parts) h.embed(part);
		h.endArray();
		h.endStruct();
	}
}

export class BooleanGeometry extends CachedGeometry {
	constructor(operator, operands) {
		super();
		this.m_operator = operator;
		this.m_operands = operands;
	}

	toContoursImpl() {
		if (this.m_operands.length === 0) return [];

		const stack = [];
		this.asOpStackImpl(stack);
		const arcs = TypoGeom.Boolean.combineStack(stack, CurveUtil.BOOLE_RESOLUTION);
		const ctx = new CurveUtil.BezToContoursSink();
		TypoGeom.ShapeConv.transferBezArcShape(arcs, ctx);
		return ctx.contours;
	}
	asOpStackImpl(sink) {
		if (this.m_operands.length === 0) {
			sink.push({
				type: "operand",
				fillType: TypoGeom.Boolean.PolyFillType.pftNonZero,
				shape: [],
			});
			return;
		}

		for (const [i, operand] of this.m_operands.entries()) {
			// Push operand
			if (operand instanceof BooleanGeometry) {
				operand.asOpStackImpl(sink);
			} else {
				sink.push({
					type: "operand",
					fillType: TypoGeom.Boolean.PolyFillType.pftNonZero,
					shape: CurveUtil.convertShapeToArcs(operand.toContours()),
				});
			}
			// Push operator if i > 0
			if (i > 0) sink.push({ type: "operator", operator: this.m_operator });
		}
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		let results = [];
		for (const part of this.m_operands) {
			const rs = part.getDependencies();
			if (!rs) continue;
			for (const c of rs) results.push(c);
		}
		return results;
	}
	filterTag(fn) {
		let filtered = [];
		for (const operand of this.m_operands) {
			const fp = operand.filterTag(fn);
			if (fp) filtered.push(fp);
		}
		return new BooleanGeometry(this.m_operator, filtered);
	}
	measureComplexity() {
		let s = CPLX_NON_SIMPLE;
		for (const operand of this.m_operands) s |= operand.measureComplexity();
		return s;
	}
	unlinkReferences() {
		if (this.m_operands.length === 0) return new CombineGeometry([]);
		if (this.m_operands.length === 1) return this.m_operands[0].unlinkReferences();
		let operands = [];
		for (const operand of this.m_operands) {
			operands.push(operand.unlinkReferences());
		}
		return new BooleanGeometry(this.m_operator, operands);
	}

	hash(h) {
		h.beginStruct("BooleanGeometry");
		h.u32(this.m_operator);
		h.beginArray(this.m_operands.length);
		for (const operand of this.m_operands) h.embed(operand);
		h.endArray();
		h.endStruct();
	}
}

export class StrokeGeometry extends CachedGeometry {
	constructor(geom, gizmo, radius, contrast, fInside) {
		super();
		this.m_geom = geom;
		this.m_gizmo = gizmo;
		this.m_radius = radius;
		this.m_contrast = contrast;
		this.m_fInside = fInside;
	}

	toContoursImpl(ctx) {
		// Produce simplified arcs
		const nonTransformedGeometry = new TransformedGeometry(this.m_gizmo.inverse(), this.m_geom);
		let arcs = TypoGeom.Boolean.removeOverlap(
			CurveUtil.convertShapeToArcs(nonTransformedGeometry.toContours(ctx)),
			TypoGeom.Boolean.PolyFillType.pftNonZero,
			CurveUtil.BOOLE_RESOLUTION,
		);

		// Fairize to get get some arcs that are simple enough
		const fairizedArcs = TypoGeom.Fairize.fairizeBezierShape(arcs);

		// Stroke the arcs
		const strokedArcs = strokeArcs(
			fairizedArcs,
			this.m_radius,
			this.m_contrast,
			this.m_fInside,
		);

		// Convert to Iosevka format
		let sink = new CurveUtil.BezToContoursSink(this.m_gizmo);
		TypoGeom.ShapeConv.transferBezArcShape(strokedArcs, sink, CurveUtil.GEOMETRY_PRECISION);

		return sink.contours;
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		return this.m_geom.getDependencies();
	}
	unlinkReferences() {
		return new StrokeGeometry(
			this.m_geom.unlinkReferences(),
			this.m_gizmo,
			this.m_radius,
			this.m_contrast,
			this.m_fInside,
		);
	}
	filterTag(fn) {
		return new StrokeGeometry(
			this.m_geom.filterTag(fn),
			this.m_gizmo,
			this.m_radius,
			this.m_contrast,
			this.m_fInside,
		);
	}
	measureComplexity() {
		return this.m_geom.measureComplexity() | CPLX_NON_SIMPLE;
	}

	hash(h) {
		h.beginStruct("StrokeGeometry");
		h.embed(this.m_geom);
		h.gizmo(this.m_gizmo);
		h.f64(this.m_radius);
		h.f64(this.m_contrast);
		h.bool(this.m_fInside);
		h.endStruct();
	}
}

// This special geometry type is used in the finalization phase to create TTF contours.
export class SimplifyGeometry extends CachedGeometry {
	constructor(g) {
		super();
		this.m_geom = g;
	}
	toContoursImpl(ctx) {
		// Produce simplified arcs
		let arcs = CurveUtil.convertShapeToArcs(this.m_geom.toContours(ctx));
		if (this.m_geom.measureComplexity() & CPLX_NON_SIMPLE) {
			arcs = TypoGeom.Boolean.removeOverlap(
				arcs,
				TypoGeom.Boolean.PolyFillType.pftNonZero,
				CurveUtil.BOOLE_RESOLUTION,
			);
		}

		// Convert to TT curves
		const sink = new QuadifySink();
		TypoGeom.ShapeConv.transferGenericShape(
			TypoGeom.Fairize.fairizeBezierShape(arcs),
			sink,
			CurveUtil.GEOMETRY_PRECISION,
		);
		return sink.contours;
	}
	toReferences() {
		return null;
	}
	getDependencies() {
		return this.m_geom.getDependencies();
	}
	unlinkReferences() {
		return new SimplifyGeometry(this.m_geom.unlinkReferences());
	}
	filterTag(fn) {
		return new SimplifyGeometry(this.m_geom.filterTag(fn));
	}
	measureComplexity() {
		return this.m_geom.measureComplexity();
	}

	hash(h) {
		h.beginStruct("SimplifyGeometry");
		h.embed(this.m_geom);
		h.endStruct();
	}
}

// Utility functions
export function combineWith(a, b) {
	if (a instanceof CombineGeometry) {
		return a.with(b);
	} else {
		return new CombineGeometry([a, b]);
	}
}

export function hashGeometry(geom) {
	const hasher = new Format.Hasher();
	geom.hash(hasher);
	return hasher.digest();
}
