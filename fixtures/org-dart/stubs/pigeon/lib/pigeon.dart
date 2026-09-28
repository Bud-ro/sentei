/// Stand-in for package:pigeon.
class ConfigurePigeon {
  const ConfigurePigeon(this.options);
  final PigeonOptions options;
}

class PigeonOptions {
  const PigeonOptions({this.dartOut});
  final String? dartOut;
}

class HostApi {
  const HostApi();
}
