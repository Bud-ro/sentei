// Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.

import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:analyzer/diagnostic/diagnostic.dart' as analyzer;
import 'package:analyzer/source/line_info.dart';
import 'package:package_config/package_config.dart';
import 'package:pubspec_parse/pubspec_parse.dart';
import 'package:scip_dart/src/kind_generator.dart';
import 'package:scip_dart/src/metadata.dart';
import 'package:scip_dart/src/gen/scip.pb.dart';
import 'package:scip_dart/src/relationship_generator.dart';
import 'package:scip_dart/src/symbol_generator.dart';
import 'package:scip_dart/src/utils.dart';

List<SymbolInformation> globalExternalSymbols = [];

class ScipVisitor extends GeneralizingAstVisitor {
  final String _relativePath;
  final String _projectRoot;
  final LineInfo _lineInfo;
  final List<analyzer.Diagnostic> _analysisErrors;

  final SymbolGenerator _symbolGenerator;

  final List<Occurrence> occurrences = [];
  final List<SymbolInformation> symbols = [];

  ScipVisitor(
    this._relativePath,
    this._projectRoot,
    this._lineInfo,
    this._analysisErrors,
    PackageConfig packageConfig,
    Pubspec pubspec,
  ) : _symbolGenerator = SymbolGenerator(packageConfig, pubspec) {
    final fileSymbol = _symbolGenerator.fileSymbolFor(_relativePath);
    occurrences.add(
      Occurrence(
        symbol: fileSymbol,
        range: [0, 0, 0],
        syntaxKind: SyntaxKind.IdentifierModule,
        symbolRoles: SymbolRole.Definition.value,
      ),
    );
    symbols.add(SymbolInformation(symbol: fileSymbol));
  }

  @override
  void visitNode(AstNode node) {
    // A dartdoc link (`/// See [foo].`) names a symbol but does not use it:
    // no occurrence for it or anything inside it.
    if (node is CommentReference) return;

    // [visitDeclaration] on the [GeneralizingAstVisitor] does not match parameters
    // even though the parameter node extends [Declaration]. This is a workaround
    // to correctly parse all [Declaration] ast nodes.
    if (node is Declaration) {
      _visitDeclaration(node);
    } else if (node is FormalParameter) {
      _visitFormalParameter(node);
    } else if (node is SimpleIdentifier) {
      _visitSimpleIdentifier(node);
    } else if (node is NamedType) {
      _visitNamedType(node);
    } else if (node is ImportPrefixReference) {
      _visitImportPrefixReference(node);
    } else if (node is NamedArgument) {
      _visitNamedArgument(node);
    } else if (node is BinaryExpression) {
      // `a + b`, `a == b`, `a != b` (resolves to `==`), `a & b`, ...
      _visitOperator(
        node,
        node.element,
        node.operator.offset,
        node.operator.length,
      );
    } else if (node is PrefixExpression) {
      // `-a` (`unary-`), `~a`, `++a` (`+`); `!a` has no element.
      _visitOperator(
        node,
        node.element,
        node.operator.offset,
        node.operator.length,
      );
    } else if (node is PostfixExpression) {
      // `a++` (`+`); `a!` has no element.
      _visitOperator(
        node,
        node.element,
        node.operator.offset,
        node.operator.length,
      );
    } else if (node is AssignmentExpression) {
      // `a += b` (`+`); a plain `=` has no element.
      _visitOperator(
        node,
        node.element,
        node.operator.offset,
        node.operator.length,
      );
    } else if (node is IndexExpression) {
      _visitIndexExpression(node);
    }

    super.visitNode(node);
  }

  /// A user-defined operator applied by an expression: a reference at the
  /// operator token. Nothing names the operator (or its extension), so
  /// without this `a + b` kept no member of `a`'s type (or extension) alive.
  /// Operators of `dart:` libraries (`int +`, `Object ==`) are skipped: they
  /// are never an org package's code and are on nearly every line.
  void _visitOperator(AstNode node, Element? element, int offset, int length) {
    if (element == null || element.source == null) return;
    if (element.library?.isInSdk == true) return;
    _registerAsReference(element, node, offset: offset, length: length);
  }

  /// `a[i]` references `[]`; as an assignment target (`a[i] = v`) `[]=`, and
  /// both when compound (`a[i] += v`, `a[i]++`): the assignment carries them
  /// as its read and write elements, the index expression has none then.
  /// The reference is at the `[` token.
  void _visitIndexExpression(IndexExpression node) {
    final parent = node.parent;
    final bracket = node.leftBracket;
    if (parent is CompoundAssignmentExpression &&
        _assignmentTarget(parent) == node) {
      _visitOperator(node, parent.readElement, bracket.offset, bracket.length);
      if (parent.writeElement != parent.readElement) {
        _visitOperator(
          node,
          parent.writeElement,
          bracket.offset,
          bracket.length,
        );
      }
      return;
    }
    _visitOperator(node, node.element, bracket.offset, bracket.length);
  }

  static Expression? _assignmentTarget(CompoundAssignmentExpression e) =>
      switch (e) {
        AssignmentExpression a => a.leftHandSide,
        PrefixExpression p => p.operand,
        PostfixExpression p => p.operand,
        _ => null,
      };

  void _visitDeclaration(Declaration node) {
    final element = _symbolGenerator.elementFor(node);
    if (element == null) return;

    final relationships = relationshipsFor(node, element, _symbolGenerator);

    _registerAsDefinition(element, node, relationships: relationships);
  }

  void _visitFormalParameter(FormalParameter node) {
    final element = _symbolGenerator.elementFor(node);
    if (element == null) return;

    // if the parameter is a `this.someFieldOnThClass`, we need to register
    // it as a reference to said field, as well as a declaration of a parameter.
    if (node is FieldFormalParameter) {
      final fieldElement = (element as FieldFormalParameterElement).field;
      if (fieldElement == null) return;
      _registerAsReference(
        fieldElement,
        node,
        offset: node.name.offset,
        length: node.name.length,
      );

      // non-named parameters are considered 'local' symbols, and when combined
      // with field formal parameters (this.foo), do not contain a declaration.
      // if its not named, do not register it as a definition as well.
      if (!node.isNamed) return;
    }

    _registerAsDefinition(element, node);
  }

  void _visitSimpleIdentifier(SimpleIdentifier node) {
    final element = _symbolGenerator.elementFor(node);
    if (element == null) return;

    if (node.inDeclarationContext()) {
      _registerAsDefinition(element, node);
    } else {
      _registerAsReference(
        element,
        node,
        offset: node.offset,
        length: node.name.length,
      );
    }
  }

  void _visitNamedType(NamedType node) {
    final element = _symbolGenerator.elementFor(node);
    if (element == null) return;

    _registerAsReference(
      element,
      node,
      offset: node.name.offset,
      length: node.name.length,
    );
  }

  void _visitImportPrefixReference(ImportPrefixReference node) {
    final element = _symbolGenerator.elementFor(node);
    if (element == null) return;

    _registerAsReference(
      element,
      node,
      offset: node.name.offset,
      length: node.name.length,
    );
  }

  void _visitNamedArgument(NamedArgument node) {
    final element = _symbolGenerator.elementFor(node);
    if (element == null) return;

    _registerAsReference(
      element,
      node,
      offset: node.name.offset,
      length: node.name.length,
    );
  }

  /// Registers the provided [element] as a reference to an existing definition
  ///
  /// [node] refers to the ast node where the reference exists, [element]
  /// is the resolved element of the downstream element.
  ///
  /// If [element] exists outside of the projects source, it will be added to the
  /// [globalExternalSymbols].
  void _registerAsReference(
    Element element,
    AstNode node, {
    required int offset,
    required int length,
  }) {
    final symbol = _symbolGenerator.symbolFor(element);
    if (symbol != null) {
      final meta = getSymbolMetadata(element, offset, _analysisErrors);
      occurrences.add(
        Occurrence(
          range: _lineInfo.getRange(offset, length),
          symbol: symbol,
          diagnostics: meta.diagnostics,
        ),
      );

      if (!element.source!.fullName.startsWith(_projectRoot)) {
        if (!globalExternalSymbols.any(
          (symbolInfo) => symbolInfo.symbol == symbol,
        )) {
          final meta = getSymbolMetadata(element, offset, _analysisErrors);
          globalExternalSymbols.add(
            SymbolInformation(
              symbol: symbol,
              documentation: meta.documentation,
              signatureDocumentation: meta.signatureDocumentation,
              kind: symbolKindFor(element),
            ),
          );
        }
      }
    }
  }

  /// Registers a provided [element] as a definition
  ///
  /// This adds both a symbol, and an occurrence for the element and it's
  /// name
  void _registerAsDefinition(
    Element element,
    AstNode node, {
    List<Relationship>? relationships,
  }) {
    final symbol = _symbolGenerator.symbolFor(element);
    if (symbol == null) return null;

    final meta = getSymbolMetadata(
      element,
      element.nameOffset,
      _analysisErrors,
    );
    symbols.add(
      SymbolInformation(
        symbol: symbol,
        documentation: meta.documentation,
        relationships: relationships,
        signatureDocumentation: meta.signatureDocumentation,
        kind: symbolKindFor(element),
      ),
    );

    occurrences.add(
      Occurrence(
        range: _lineInfo.getRange(element.nameOffset, element.nameLength),
        symbol: symbol,
        symbolRoles: SymbolRole.Definition.value,
        diagnostics: meta.diagnostics,
        enclosingRange: _enclosingRange(node),
      ),
    );
  }

  /// The source range a definition encloses: the declaration node, except
  /// that a top-level variable or field (a [VariableDeclaration], which
  /// starts at its name) also covers what precedes it in its declaration:
  /// doc comment, metadata, modifiers and the type annotation. A reference
  /// in `final Map<K, V> _x = ...;`'s type is a use by `_x`, not by the file
  /// or class around it (sentei patch 12). With several variables in one
  /// declaration (`int a = 1, b = 2;`) each range starts at the declaration;
  /// the first variable gets the type (the innermost range wins).
  List<int> _enclosingRange(AstNode node) {
    var start = node.offset;
    if (node is VariableDeclaration) {
      final list = node.parent;
      final decl = list?.parent;
      if (list is VariableDeclarationList &&
          (decl is TopLevelVariableDeclaration || decl is FieldDeclaration)) {
        start = decl!.offset;
      }
    }
    return _lineInfo.getRange(start, node.end - start);
  }
}
