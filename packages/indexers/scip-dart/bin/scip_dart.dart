// Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.

import 'dart:io';

import 'package:args/args.dart';
import 'package:pubspec_lock_parse/pubspec_lock_parse.dart';
import 'package:scip_dart/scip_dart.dart';
import 'package:package_config/package_config.dart';
import 'package:pubspec_parse/pubspec_parse.dart';
import 'package:path/path.dart' as p;
import 'package:scip_dart/src/flags.dart';
import 'package:scip_dart/src/indexer.dart' show PackageTarget, indexPackages;
import 'package:scip_dart/src/pubspec_indexer.dart';
import 'package:scip_dart/src/version.dart';

Future<void> main(List<String> args) async {
  final result =
      (ArgParser()
            ..addOption(
              'output',
              abbr: 'o',
              defaultsTo: 'index.scip',
              help: 'The output file to write the index to. Use "-" to write to stdout',
            )
            ..addFlag(
              'index-pubspec',
              defaultsTo: false,
              help: 'Whether or not to index the pubspec.yaml file',
            )
            ..addFlag(
              'performance',
              aliases: ['perf'],
              defaultsTo: false,
              help: 'Whether or not to output performance metrics during indexing',
            )
            ..addFlag(
              'verbose',
              abbr: 'v',
              defaultsTo: false,
              help: 'Whether or not to display debugging text during indexing',
            )
            ..addFlag(
              'private-symbols',
              defaultsTo: false,
              help:
                  'Emit global symbols for private (_name) declarations '
                  'instead of local symbols',
            )
            ..addOption(
              'sdk-path',
              help:
                  'Dart SDK the analyzer resolves dart: libraries from '
                  '(default: the SDK running scip-dart)',
            )
            ..addMultiOption(
              'package',
              help:
                  'Index several packages in one run, as <dir>=<output> '
                  '(repeatable): the positional directory is then the pub '
                  'workspace root whose package config resolves them all, and '
                  'each package gets its own index, as if indexed alone',
            )
            ..addFlag(
              'version',
              defaultsTo: false,
              help: 'Display the current version of scip-dart',
            )
            ..addFlag(
              'index-relationships',
              help: 'DEPRECATED, has no effect on executed code',
            )
            ..addMultiOption(
              'path',
              abbr: 'p',
              help: 'DEPRECATED, has no effect on executed code',
            ))
          .parse(args);

  if (result['version'] as bool) {
    print(scipDartVersion);
    exit(0);
  }

  Flags.instance.init(result);

  if ((result['path'] as List<String>?)?.isNotEmpty == true) {
    print(
      'The --path/-p flag is deprecated and no longer used. '
      'All dart files in the provided directory are indexed by '
      'default.',
    );
  }

  final packageRoot = result.rest.isNotEmpty
      ? result.rest.first
      : Directory.current.path;

  final packageConfig = await findPackageConfig(Directory(packageRoot));
  if (packageConfig == null) {
    stderr.writeln('ERROR: Unable to locate packageConfig');
    exit(1);
  }

  final packages = result['package'] as List<String>;
  if (packages.isNotEmpty) {
    if (result['index-pubspec'] as bool) {
      stderr.writeln(
        'ERROR: --index-pubspec cannot be combined with --package',
      );
      exit(64);
    }
    final targets = <PackageTarget>[];
    final outputs = <PackageTarget, String>{};
    for (final spec in packages) {
      final eq = spec.indexOf('=');
      if (eq <= 0 || eq == spec.length - 1) {
        stderr.writeln('ERROR: --package expects <dir>=<output>, got "$spec"');
        exit(64);
      }
      final dir = spec.substring(0, eq);
      final file = File(p.join(dir, 'pubspec.yaml'));
      if (!file.existsSync()) {
        stderr.writeln('ERROR: Unable to locate pubspec.yaml in $dir');
        exit(1);
      }
      final target = PackageTarget(dir, Pubspec.parse(file.readAsStringSync()));
      targets.add(target);
      outputs[target] = spec.substring(eq + 1);
    }
    await indexPackages(packageRoot, packageConfig, targets, (target, index) {
      File(outputs[target]!).writeAsBytesSync(index.writeToBuffer());
    });
    return;
  }

  final pubspecFile = File(p.join(packageRoot, 'pubspec.yaml'));
  if (!pubspecFile.existsSync()) {
    stderr.writeln('ERROR: Unable to locate pubspec.yaml');
    exit(1);
  }
  final pubspecStr = pubspecFile.readAsStringSync();
  final pubspec = Pubspec.parse(pubspecStr);

  final index = await indexPackage(packageRoot, packageConfig, pubspec);

  if (result['index-pubspec'] as bool) {
    final pubspecLockFile = File(p.join(packageRoot, 'pubspec.lock'));
    if (!pubspecLockFile.existsSync()) {
      stderr.writeln(
        'ERROR: Unable to locate pubspec.lock. Have you ran pub get?',
      );
      exit(1);
    }
    final pubspecLock = PubspecLock.parse(pubspecLockFile.readAsStringSync());

    index.documents.add(
      indexPubspec(
        pubspec: pubspec,
        pubspecStr: pubspecStr,
        pubspecLock: pubspecLock,
      ),
    );
  }

  if (result['output'] as String == '-') {
    stdout.add(index.writeToBuffer());
    stdout.flush();
  } else {
    File(result['output'] as String).writeAsBytesSync(index.writeToBuffer());
  }
}
